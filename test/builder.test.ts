import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildDockerArgs,
  computeBuildMetadata,
  createBuildScriptEnv,
  discoverBuildSecrets,
} from '../src/builder.js';
import type { Config } from '../src/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    gitRepo: 'https://github.com/wuhao5/myapp.git',
    gitBranches: ['main', 'feature/login'],
    gitPat: '',
    gitPatSource: 'none',
    gitPatFile: '/app/secrets/pat',
    triggerMode: 'poll',
    runOnStartup: true,
    checkIntervalMinutes: 60,
    gitTimeoutMs: 300_000,
    buildTimeoutMs: 1_800_000,
    dockerfilePath: 'docker',
    dockerImageName: 'myapp',
    shouldTagEachBuild: false,
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
});

describe('discoverBuildSecrets', () => {
  it('excludes pat, webhook_secret, dotfiles, directories, and custom reserved paths', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-builder-secrets-'));
    try {
      fs.writeFileSync(path.join(tmp, 'pat'), 'ghp_secret');
      fs.writeFileSync(path.join(tmp, 'webhook_secret'), 'hook_secret');
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
