import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildComposeArgs,
  buildDockerArgs,
  buildDockerImage,
  computeBuildMetadata,
  createBuildScriptEnv,
  discoverBuildSecrets,
  hasCustomDockerfileFlag,
  shouldDeployCompose,
} from '../src/builder.js';
import type { Config } from '../src/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    gitRepo: 'https://github.com/wuhao5/myapp.git',
    gitBranches: ['main', 'feature/login'],
    gitTagPatterns: [],
    tagLatest: true,
    gitPat: '',
    gitPatSource: 'none',
    gitPatFile: '/app/secrets/pat',
    triggerMode: 'poll',
    runOnStartup: true,
    checkIntervalMinutes: 60,
    gitTimeoutMs: 300_000,
    buildTimeoutMs: 1_800_000,
    composeTimeoutMs: 300_000,
    dockerfilePath: 'docker',
    dockerImageName: 'myapp',
    dockerBuildFlags: [],
    shouldTagEachBuild: false,
    composeServices: [],
    watchtowerToken: '',
    watchtowerTokenSource: 'none',
    watchtowerTokenFile: '/app/secrets/watchtower_token',
    watchtowerTimeoutMs: 120_000,
    webhookPort: 9000,
    webhookHost: '0.0.0.0',
    webhookPath: '/webhook',
    webhookSecret: '',
    webhookSecretSource: 'none',
    webhookSecretFile: '/app/secrets/webhook_secret',
    repoDir: '/app/repo',
    stateDir: '/app/state',
    secretsDir: '/app/secrets',
    ...overrides,
  };
}

describe('computeBuildMetadata', () => {
  it('computes independent per-branch tags without mutating shared config', () => {
    const cfg = makeConfig({ shouldTagEachBuild: true });
    const fixedDate = new Date(2026, 10, 19, 15, 30, 45);

    const mainMeta = computeBuildMetadata(cfg, 'main', 'abcdef1234567890', fixedDate);
    const featureMeta = computeBuildMetadata(cfg, 'feature/login', '9876543210fedcba', fixedDate);

    assert.equal(mainMeta.imageTag, 'myapp:main-abcdef1');
    assert.equal(mainMeta.imageBranch, 'myapp:main');
    assert.equal(mainMeta.imageLatest, 'myapp:latest');
    assert.equal(mainMeta.buildTimestamp, '20261119-153045');

    assert.equal(featureMeta.branchSafe, 'feature-login');
    assert.equal(featureMeta.imageTag, 'myapp:feature-login-9876543');
    assert.equal(featureMeta.imageBranch, 'myapp:feature-login');
    assert.equal(featureMeta.imageLatest, undefined);
  });

  it('omits commit-based imageTag when SHOULD_TAG_EACH_BUILD is false and IMAGE_TAG is unset', () => {
    const cfg = makeConfig({ shouldTagEachBuild: false });
    const meta = computeBuildMetadata(cfg, 'main', 'abcdef1234567890');
    assert.equal(meta.imageTag, undefined);
    assert.equal(meta.imageBranch, 'myapp:main');
    assert.equal(meta.imageLatest, 'myapp:latest');

    const env = createBuildScriptEnv(cfg, meta, {});
    assert.equal(env.IMAGE_TAG, '');
    assert.equal(env.IMAGE_LATEST, 'myapp:latest');
    assert.equal(env.IMAGE_BRANCH, 'myapp:main');
    assert.equal(env.GIT_COMMIT_SHORT, 'abcdef1');
  });

  it('builds docker buildx arguments with build args, secrets, and tags', () => {
    const cfg = makeConfig({ shouldTagEachBuild: true });
    const meta = computeBuildMetadata(cfg, 'main', 'abcdef1234567890');
    const args = buildDockerArgs(cfg, meta, [
      { id: 'api.key', src: '/app/secrets/api.key' },
    ]);

    assert.equal(args[0], 'buildx');
    assert.equal(args[1], 'build');
    assert.ok(args.includes('--secret'));
    assert.ok(args.includes('id=api.key,src=/app/secrets/api.key'));
    assert.ok(args.includes('myapp:main-abcdef1'));
    assert.ok(args.includes('myapp:main'));
    assert.equal(args[args.length - 1], path.resolve('/app/repo', 'docker'));
  });

  it('includes DOCKER_BUILD_FLAGS before tags and build context', () => {
    const cfg = makeConfig({
      dockerBuildFlags: ['--target', 'ab-hive-aio', '--no-cache', '--platform', 'linux/amd64'],
      shouldTagEachBuild: false,
    });
    const meta = computeBuildMetadata(cfg, 'main', 'abcdef1234567890');
    const args = buildDockerArgs(cfg, meta, []);

    const targetIndex = args.indexOf('--target');
    assert.ok(targetIndex > 0);
    assert.equal(args[targetIndex + 1], 'ab-hive-aio');

    const noCacheIndex = args.indexOf('--no-cache');
    assert.ok(noCacheIndex > targetIndex);
    assert.equal(args[noCacheIndex + 1], '--platform');
    assert.equal(args[noCacheIndex + 2], 'linux/amd64');

    const tagIndex = args.indexOf('-t');
    assert.ok(tagIndex > noCacheIndex + 2);
    assert.equal(args[tagIndex + 1], 'myapp:main');
    assert.equal(args[args.length - 1], path.resolve('/app/repo', 'docker'));
  });

  it('computes Docker tags and build args for Git tag builds without duplicate -t flags', () => {
    const cfg = makeConfig({ gitTagPatterns: ['v*'], tagLatest: true });
    const meta = computeBuildMetadata(cfg, 'v1.2.3', 'abcdef1234567890', new Date(), 'tag');

    assert.equal(meta.refType, 'tag');
    assert.equal(meta.gitTag, 'v1.2.3');
    assert.equal(meta.imageTag, 'myapp:v1.2.3');
    assert.equal(meta.imageBranch, 'myapp:v1.2.3');
    assert.equal(meta.imageLatest, 'myapp:latest');

    const args = buildDockerArgs(cfg, meta, []);
    assert.ok(args.includes('GIT_TAG=v1.2.3'));
    const tagFlags = args.filter((arg) => arg === '-t');
    assert.equal(tagFlags.length, 1);
    assert.equal(args[args.indexOf('-t') + 1], 'myapp:v1.2.3');

    const noLatestMeta = computeBuildMetadata(
      makeConfig({ gitTagPatterns: ['v*'], tagLatest: false }),
      'v1.2.3',
      'abcdef1234567890',
      new Date(),
      'tag',
    );
    assert.equal(noLatestMeta.imageLatest, undefined);

    const scriptEnv = createBuildScriptEnv(cfg, meta, {});
    assert.equal(scriptEnv.GIT_TAG, 'v1.2.3');
    assert.equal(scriptEnv.GIT_REF_TYPE, 'tag');
    assert.equal(scriptEnv.IMAGE_TAG, 'myapp:v1.2.3');
    assert.equal(scriptEnv.IMAGE_LATEST, 'myapp:latest');
  });
});

describe('hasCustomDockerfileFlag', () => {
  it('detects -f and --file variants', () => {
    assert.equal(hasCustomDockerfileFlag(['--target', 'ab-hive-aio']), false);
    assert.equal(hasCustomDockerfileFlag(['-f', 'Dockerfile.prod']), true);
    assert.equal(hasCustomDockerfileFlag(['--file', 'Dockerfile.prod']), true);
    assert.equal(hasCustomDockerfileFlag(['--file=Dockerfile.prod']), true);
    assert.equal(hasCustomDockerfileFlag(['-fDockerfile.prod']), true);
  });
});

describe('buildDockerImage', () => {
  it('passes DOCKER_BUILD_FLAGS to docker buildx build and runs in build context', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-builder-docker-'));
    const originalPath = process.env.PATH ?? '';
    try {
      const binDir = path.join(tmp, 'bin');
      const repoDir = path.join(tmp, 'repo');
      const contextDir = path.join(repoDir, 'docker');
      const secretsDir = path.join(tmp, 'secrets');
      const logFile = path.join(tmp, 'docker-invocations.jsonl');

      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(contextDir, { recursive: true });
      fs.mkdirSync(secretsDir, { recursive: true });
      // Only create a non-default Dockerfile to verify -f bypasses default Dockerfile check
      fs.writeFileSync(path.join(contextDir, 'Dockerfile.aio'), 'FROM alpine:latest\n');

      const fakeDockerPath = path.join(binDir, 'docker');
      fs.writeFileSync(
        fakeDockerPath,
        `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
`,
        { mode: 0o755 },
      );

      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

      const cfg = makeConfig({
        repoDir,
        secretsDir,
        dockerfilePath: 'docker',
        dockerImageName: 'myapp',
        dockerBuildFlags: ['--target', 'ab-hive-aio', '-f', 'Dockerfile.aio', '--no-cache'],
      });

      const ok = await buildDockerImage(cfg, 'main', 'abcdef1234567890');
      assert.equal(ok, true);

      const invocations = fs
        .readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { cwd: string; args: string[] });

      assert.equal(invocations.length, 2); // buildx build + tag :latest
      const [buildCall, tagCall] = invocations;
      assert.ok(buildCall);
      assert.ok(tagCall);
      assert.equal(fs.realpathSync(buildCall.cwd), fs.realpathSync(contextDir));
      const buildArgs = buildCall.args;
      assert.equal(buildArgs[0], 'buildx');
      assert.equal(buildArgs[1], 'build');
      const targetIdx = buildArgs.indexOf('--target');
      assert.ok(targetIdx > 0);
      assert.equal(buildArgs[targetIdx + 1], 'ab-hive-aio');
      assert.ok(buildArgs.includes('-f'));
      assert.ok(buildArgs.includes('Dockerfile.aio'));
      assert.ok(buildArgs.includes('--no-cache'));
      assert.equal(buildArgs[buildArgs.length - 1], contextDir);

      assert.deepEqual(tagCall.args, ['tag', 'myapp:main', 'myapp:latest']);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('propagates docker build failure when invalid flags are passed', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-builder-docker-fail-'));
    const originalPath = process.env.PATH ?? '';
    try {
      const binDir = path.join(tmp, 'bin');
      const repoDir = path.join(tmp, 'repo');
      const contextDir = path.join(repoDir, 'docker');
      const secretsDir = path.join(tmp, 'secrets');

      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(contextDir, { recursive: true });
      fs.mkdirSync(secretsDir, { recursive: true });
      fs.writeFileSync(path.join(contextDir, 'Dockerfile'), 'FROM alpine:latest\n');

      const fakeDockerPath = path.join(binDir, 'docker');
      fs.writeFileSync(
        fakeDockerPath,
        `#!/usr/bin/env node
console.error('ERROR: unknown flag: --not-a-real-flag');
process.exit(1);
`,
        { mode: 0o755 },
      );

      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

      const cfg = makeConfig({
        repoDir,
        secretsDir,
        dockerfilePath: 'docker',
        dockerImageName: 'myapp',
        dockerBuildFlags: ['--not-a-real-flag'],
      });

      const ok = await buildDockerImage(cfg, 'main', 'abcdef1234567890');
      assert.equal(ok, false);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('redeploys configured Docker Compose project after build and tagging', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-builder-compose-'));
    const originalPath = process.env.PATH ?? '';
    try {
      const binDir = path.join(tmp, 'bin');
      const repoDir = path.join(tmp, 'repo');
      const contextDir = path.join(repoDir, 'docker');
      const secretsDir = path.join(tmp, 'secrets');
      const composeDir = path.join(tmp, 'my-project');
      const logFile = path.join(tmp, 'docker-invocations.jsonl');

      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(contextDir, { recursive: true });
      fs.mkdirSync(secretsDir, { recursive: true });
      fs.mkdirSync(composeDir, { recursive: true });
      fs.writeFileSync(path.join(contextDir, 'Dockerfile'), 'FROM alpine:latest\n');
      fs.writeFileSync(path.join(composeDir, 'compose.yaml'), 'services:\n  web:\n    image: myapp:latest\n');

      const fakeDockerPath = path.join(binDir, 'docker');
      fs.writeFileSync(
        fakeDockerPath,
        `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
`,
        { mode: 0o755 },
      );

      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

      const cfg = makeConfig({
        repoDir,
        secretsDir,
        dockerfilePath: 'docker',
        dockerImageName: 'myapp',
        composeProjectDir: composeDir,
        composeProjectName: 'my-app',
        composeServices: ['web', 'worker'],
        composeBranch: 'main',
      });

      const ok = await buildDockerImage(cfg, 'main', 'abcdef1234567890');
      assert.equal(ok, true);

      const invocations = fs
        .readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { cwd: string; args: string[] });

      assert.equal(invocations.length, 3); // buildx build + tag :latest + compose up
      const composeCall = invocations[2];
      assert.ok(composeCall);
      assert.equal(fs.realpathSync(composeCall.cwd), fs.realpathSync(composeDir));
      assert.deepEqual(composeCall.args, [
        'compose',
        '-p',
        'my-app',
        'up',
        '-d',
        '--no-build',
        '--no-deps',
        'web',
        'worker',
      ]);

      // Building a different branch should skip compose redeploy when COMPOSE_BRANCH=main
      fs.writeFileSync(logFile, '');
      const okFeature = await buildDockerImage(cfg, 'develop', 'abcdef1234567890');
      assert.equal(okFeature, true);
      const devInvocations = fs
        .readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { cwd: string; args: string[] });
      assert.equal(devInvocations.length, 1); // only buildx build (no :latest, no compose)
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fails build step when COMPOSE_PROJECT_DIR does not exist or compose up fails', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-builder-compose-fail-'));
    const originalPath = process.env.PATH ?? '';
    try {
      const binDir = path.join(tmp, 'bin');
      const repoDir = path.join(tmp, 'repo');
      const contextDir = path.join(repoDir, 'docker');
      const secretsDir = path.join(tmp, 'secrets');
      const composeDir = path.join(tmp, 'existing-project');

      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(contextDir, { recursive: true });
      fs.mkdirSync(secretsDir, { recursive: true });
      fs.mkdirSync(composeDir, { recursive: true });
      fs.writeFileSync(path.join(contextDir, 'Dockerfile'), 'FROM alpine:latest\n');

      const fakeDockerPath = path.join(binDir, 'docker');
      fs.writeFileSync(
        fakeDockerPath,
        `#!/usr/bin/env node
if (process.argv[2] === 'compose') {
  process.exit(1);
}
`,
        { mode: 0o755 },
      );

      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

      const missingDirCfg = makeConfig({
        repoDir,
        secretsDir,
        dockerfilePath: 'docker',
        composeProjectDir: path.join(tmp, 'does-not-exist'),
      });
      assert.equal(await buildDockerImage(missingDirCfg, 'main', 'abcdef1234567890'), false);

      const failingComposeCfg = makeConfig({
        repoDir,
        secretsDir,
        dockerfilePath: 'docker',
        composeProjectDir: composeDir,
      });
      assert.equal(await buildDockerImage(failingComposeCfg, 'main', 'abcdef1234567890'), false);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('triggers Watchtower HTTP API after successful build and tagging', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-builder-wt-build-'));
    const originalPath = process.env.PATH ?? '';
    const wtRequests: Array<{ url: string; auth: string }> = [];

    const mockWatchtower = http.createServer((req, res) => {
      wtRequests.push({
        url: req.url ?? '',
        auth: req.headers.authorization ?? '',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary: { scanned: 1, updated: 1, failed: 0 } }));
    });

    await new Promise<void>((resolve) => mockWatchtower.listen(0, '127.0.0.1', resolve));
    const wtPort = (mockWatchtower.address() as AddressInfo).port;

    try {
      const binDir = path.join(tmp, 'bin');
      const repoDir = path.join(tmp, 'repo');
      const contextDir = path.join(repoDir, 'docker');
      const secretsDir = path.join(tmp, 'secrets');

      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(contextDir, { recursive: true });
      fs.mkdirSync(secretsDir, { recursive: true });
      fs.writeFileSync(path.join(contextDir, 'Dockerfile'), 'FROM alpine:latest\n');
      fs.writeFileSync(path.join(binDir, 'docker'), '#!/usr/bin/env node\n', { mode: 0o755 });

      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

      const cfg = makeConfig({
        repoDir,
        secretsDir,
        dockerfilePath: 'docker',
        dockerImageName: 'myapp',
        watchtowerUrl: `http://127.0.0.1:${wtPort}`,
        watchtowerToken: 'wt-tok',
      });

      const ok = await buildDockerImage(cfg, 'main', 'abcdef1234567890');
      assert.equal(ok, true);
      assert.deepEqual(wtRequests, [
        { url: '/v1/update?image=myapp%3Alatest', auth: 'Bearer wt-tok' },
      ]);
    } finally {
      process.env.PATH = originalPath;
      await new Promise<void>((resolve) => mockWatchtower.close(() => resolve()));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('compose helpers', () => {
  it('builds docker compose up arguments cleanly', () => {
    assert.deepEqual(
      buildComposeArgs(makeConfig({ composeProjectDir: '/volume1/docker/app' })),
      ['compose', 'up', '-d', '--no-build'],
    );
    assert.deepEqual(
      buildComposeArgs(
        makeConfig({
          composeProjectDir: '/volume1/docker/app',
          composeProjectName: 'my-app',
          composeFile: 'docker-compose.prod.yml',
          composeServices: ['web'],
        }),
      ),
      [
        'compose',
        '-p',
        'my-app',
        '-f',
        'docker-compose.prod.yml',
        'up',
        '-d',
        '--no-build',
        '--no-deps',
        'web',
      ],
    );
  });

  it('respects COMPOSE_PROJECT_DIR and COMPOSE_BRANCH gating', () => {
    assert.equal(shouldDeployCompose(makeConfig(), 'main'), false);
    assert.equal(
      shouldDeployCompose(makeConfig({ composeProjectDir: '/volume1/docker/app' }), 'develop'),
      true,
    );
    assert.equal(
      shouldDeployCompose(
        makeConfig({ composeProjectDir: '/volume1/docker/app', composeBranch: 'main' }),
        'main',
      ),
      true,
    );
    assert.equal(
      shouldDeployCompose(
        makeConfig({ composeProjectDir: '/volume1/docker/app', composeBranch: 'main' }),
        'develop',
      ),
      false,
    );
  });
});

describe('discoverBuildSecrets', () => {
  it('excludes pat, webhook_secret, dotfiles, directories, and custom reserved paths', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-builder-secrets-'));
    try {
      fs.writeFileSync(path.join(tmp, 'pat'), 'ghp_secret');
      fs.writeFileSync(path.join(tmp, 'webhook_secret'), 'hook_secret');
      fs.writeFileSync(path.join(tmp, 'watchtower_token'), 'wt_secret');
      fs.writeFileSync(path.join(tmp, 'custom_hook_key'), 'custom_hook');
      fs.writeFileSync(path.join(tmp, '.hidden'), 'skip');
      fs.writeFileSync(path.join(tmp, 'db.conf'), 'postgres://...');
      fs.writeFileSync(path.join(tmp, 'api.key'), '12345');
      fs.mkdirSync(path.join(tmp, 'subdir'));

      const secrets = discoverBuildSecrets(tmp, [path.join(tmp, 'custom_hook_key')]);
      assert.deepEqual(
        secrets.map((s) => s.id),
        ['api.key', 'db.conf'],
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
