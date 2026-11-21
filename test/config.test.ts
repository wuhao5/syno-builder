import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig, matchesTagPattern, normalizeWebhookPath, parseDockerBuildFlags } from '../src/config.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'syno-builder-config-'));
}

describe('loadConfig', () => {
  it('requires GIT_REPO', () => {
    assert.throws(() => loadConfig({}), /GIT_REPO environment variable is required/);
  });

  it('applies backward-compatible defaults in poll mode', () => {
    const tmp = makeTempDir();
    try {
      const cfg = loadConfig({
        GIT_REPO: 'https://github.com/user/repo.git',
        SECRETS_DIR: tmp,
      });
      assert.equal(cfg.triggerMode, 'poll');
      assert.equal(cfg.runOnStartup, true);
      assert.deepEqual(cfg.gitBranches, ['main']);
      assert.deepEqual(cfg.gitTagPatterns, []);
      assert.equal(cfg.tagLatest, true);
      assert.equal(cfg.checkIntervalMinutes, 60);
      assert.equal(cfg.gitTimeoutMs, 300_000);
      assert.equal(cfg.buildTimeoutMs, 1_800_000);
      assert.equal(cfg.dockerfilePath, '.');
      assert.equal(cfg.dockerImageName, 'auto-built-image');
      assert.deepEqual(cfg.dockerBuildFlags, []);
      assert.equal(cfg.shouldTagEachBuild, false);
      assert.equal(cfg.imageTag, undefined);
      assert.equal(cfg.webhookPort, 9000);
      assert.equal(cfg.webhookPath, '/webhook');
      assert.equal(cfg.gitPatSource, 'none');
      assert.equal(cfg.webhookSecretSource, 'none');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('parses and deduplicates multi-branch lists', () => {
    const tmp = makeTempDir();
    try {
      const cfg = loadConfig({
        GIT_REPO: 'https://github.com/user/repo.git',
        GIT_BRANCH: ' main , develop , feature/auth , main ',
        SECRETS_DIR: tmp,
      });
      assert.deepEqual(cfg.gitBranches, ['main', 'develop', 'feature/auth']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('requires webhook secret in webhook and both modes', () => {
    const tmp = makeTempDir();
    try {
      assert.throws(
        () =>
          loadConfig({
            GIT_REPO: 'https://github.com/user/repo.git',
            TRIGGER_MODE: 'webhook',
            SECRETS_DIR: tmp,
          }),
        /Webhook secret is required/,
      );

      assert.throws(
        () =>
          loadConfig({
            GIT_REPO: 'https://github.com/user/repo.git',
            TRIGGER_MODE: 'both',
            SECRETS_DIR: tmp,
          }),
        /Webhook secret is required/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('defaults RUN_ON_STARTUP to false in webhook mode and true in both mode', () => {
    const tmp = makeTempDir();
    try {
      const webhookOnly = loadConfig({
        GIT_REPO: 'https://github.com/user/repo.git',
        TRIGGER_MODE: 'webhook',
        WEBHOOK_SECRET: 'super-secret',
        SECRETS_DIR: tmp,
      });
      assert.equal(webhookOnly.runOnStartup, false);

      const both = loadConfig({
        GIT_REPO: 'https://github.com/user/repo.git',
        TRIGGER_MODE: 'both',
        WEBHOOK_SECRET: 'super-secret',
        SECRETS_DIR: tmp,
      });
      assert.equal(both.runOnStartup, true);

      const explicitTrue = loadConfig({
        GIT_REPO: 'https://github.com/user/repo.git',
        TRIGGER_MODE: 'webhook',
        WEBHOOK_SECRET: 'super-secret',
        RUN_ON_STARTUP: 'true',
        SECRETS_DIR: tmp,
      });
      assert.equal(explicitTrue.runOnStartup, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prefers mounted secret files over environment variables', () => {
    const tmp = makeTempDir();
    try {
      fs.writeFileSync(path.join(tmp, 'pat'), 'ghp_from_file\n');
      fs.writeFileSync(path.join(tmp, 'webhook_secret'), 'secret_from_file\n');

      const cfg = loadConfig({
        GIT_REPO: 'https://github.com/user/repo.git',
        TRIGGER_MODE: 'webhook',
        GIT_PAT: 'ghp_from_env',
        WEBHOOK_SECRET: 'secret_from_env',
        SECRETS_DIR: tmp,
      });

      assert.equal(cfg.gitPat, 'ghp_from_file');
      assert.equal(cfg.gitPatSource, 'file');
      assert.equal(cfg.webhookSecret, 'secret_from_file');
      assert.equal(cfg.webhookSecretSource, 'file');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('validates IMAGE_TAG, TRIGGER_MODE, CHECK_INTERVAL, and WEBHOOK_PORT', () => {
    const tmp = makeTempDir();
    try {
      assert.throws(
        () =>
          loadConfig({
            GIT_REPO: 'https://github.com/user/repo.git',
            IMAGE_TAG: 'bad tag; rm -rf /',
            SECRETS_DIR: tmp,
          }),
        /Invalid IMAGE_TAG/,
      );

      assert.throws(
        () =>
          loadConfig({
            GIT_REPO: 'https://github.com/user/repo.git',
            TRIGGER_MODE: 'invalid',
            SECRETS_DIR: tmp,
          }),
        /Invalid TRIGGER_MODE/,
      );

      assert.throws(
        () =>
          loadConfig({
            GIT_REPO: 'https://github.com/user/repo.git',
            CHECK_INTERVAL: '0',
            SECRETS_DIR: tmp,
          }),
        /Invalid CHECK_INTERVAL/,
      );

      assert.throws(
        () =>
          loadConfig({
            GIT_REPO: 'https://github.com/user/repo.git',
            WEBHOOK_PORT: '70000',
            SECRETS_DIR: tmp,
          }),
        /Invalid WEBHOOK_PORT/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('normalizes webhook paths consistently', () => {
    assert.equal(normalizeWebhookPath(undefined), '/webhook');
    assert.equal(normalizeWebhookPath('webhook'), '/webhook');
    assert.equal(normalizeWebhookPath('/hooks/github/'), '/hooks/github');
    assert.equal(normalizeWebhookPath('/'), '/');
  });

  it('loads DOCKER_BUILD_FLAGS into config', () => {
    const tmp = makeTempDir();
    try {
      const cfg = loadConfig({
        GIT_REPO: 'https://github.com/user/repo.git',
        DOCKER_BUILD_FLAGS: '--target ab-hive-aio --build-arg "MSG=hello world" --label \'env=prod\'',
        SECRETS_DIR: tmp,
      });

      assert.deepEqual(cfg.dockerBuildFlags, [
        '--target',
        'ab-hive-aio',
        '--build-arg',
        'MSG=hello world',
        '--label',
        'env=prod',
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('loads and validates Docker Compose auto-redeploy options', () => {
    const tmp = makeTempDir();
    try {
      const cfg = loadConfig({
        GIT_REPO: 'https://github.com/user/repo.git',
        COMPOSE_PROJECT_DIR: '/volume1/docker/my-app',
        COMPOSE_PROJECT_NAME: 'my-app',
        COMPOSE_SERVICE: ' web , worker , web ',
        COMPOSE_FILE: 'compose.yaml',
        COMPOSE_BRANCH: 'main',
        COMPOSE_TIMEOUT_SECONDS: '120',
        SECRETS_DIR: tmp,
      });

      assert.equal(cfg.composeProjectDir, path.resolve('/volume1/docker/my-app'));
      assert.equal(cfg.composeProjectName, 'my-app');
      assert.deepEqual(cfg.composeServices, ['web', 'worker']);
      assert.equal(cfg.composeFile, 'compose.yaml');
      assert.equal(cfg.composeBranch, 'main');
      assert.equal(cfg.composeTimeoutMs, 120_000);

      assert.throws(
        () =>
          loadConfig({
            GIT_REPO: 'https://github.com/user/repo.git',
            COMPOSE_PROJECT_NAME: '--bad-flag',
            SECRETS_DIR: tmp,
          }),
        /Invalid COMPOSE_PROJECT_NAME/,
      );

      assert.throws(
        () =>
          loadConfig({
            GIT_REPO: 'https://github.com/user/repo.git',
            COMPOSE_SERVICE: 'web,--remove-orphans',
            SECRETS_DIR: tmp,
          }),
        /Invalid COMPOSE_SERVICE/,
      );

      assert.throws(
        () =>
          loadConfig({
            GIT_REPO: 'https://github.com/user/repo.git',
            COMPOSE_FILE: '-evil.yml',
            SECRETS_DIR: tmp,
          }),
        /Invalid COMPOSE_FILE/,
      );

      assert.throws(
        () =>
          loadConfig({
            GIT_REPO: 'https://github.com/user/repo.git',
            COMPOSE_TIMEOUT_SECONDS: '-5',
            SECRETS_DIR: tmp,
          }),
        /Invalid COMPOSE_TIMEOUT_SECONDS/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('supports tag-only mode and combined branch + tag mode via GIT_TAG_PATTERN', () => {
    const tmp = makeTempDir();
    try {
      // Tag-only when GIT_BRANCH is omitted
      const tagOnly = loadConfig({
        GIT_REPO: 'https://github.com/user/repo.git',
        GIT_TAG_PATTERN: 'v*, release-*',
        SECRETS_DIR: tmp,
      });
      assert.deepEqual(tagOnly.gitBranches, []);
      assert.deepEqual(tagOnly.gitTagPatterns, ['v*', 'release-*']);
      assert.equal(tagOnly.tagLatest, true);

      // Combined branch + tag when both are specified
      const combined = loadConfig({
        GIT_REPO: 'https://github.com/user/repo.git',
        GIT_BRANCH: 'main',
        GIT_TAG_PATTERN: 'v*',
        TAG_LATEST: 'false',
        SECRETS_DIR: tmp,
      });
      assert.deepEqual(combined.gitBranches, ['main']);
      assert.deepEqual(combined.gitTagPatterns, ['v*']);
      assert.equal(combined.tagLatest, false);

      // Explicit GIT_BRANCH=none disables branches
      const explicitNone = loadConfig({
        GIT_REPO: 'https://github.com/user/repo.git',
        GIT_BRANCH: 'none',
        GIT_TAG_PATTERN: '*',
        SECRETS_DIR: tmp,
      });
      assert.deepEqual(explicitNone.gitBranches, []);
      assert.deepEqual(explicitNone.gitTagPatterns, ['*']);

      // Neither branch nor tag pattern fails validation
      assert.throws(
        () =>
          loadConfig({
            GIT_REPO: 'https://github.com/user/repo.git',
            GIT_BRANCH: 'none',
            SECRETS_DIR: tmp,
          }),
        /GIT_BRANCH or GIT_TAG_PATTERN/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('loads and validates Watchtower integration options', () => {
    const tmp = makeTempDir();
    try {
      fs.writeFileSync(path.join(tmp, 'watchtower_token'), 'wt_from_file\n');

      const cfg = loadConfig({
        GIT_REPO: 'https://github.com/user/repo.git',
        WATCHTOWER_URL: 'http://watchtower:8080/',
        WATCHTOWER_CONTAINER: 'my-app',
        WATCHTOWER_TIMEOUT_SECONDS: '45',
        SECRETS_DIR: tmp,
      });

      assert.equal(cfg.watchtowerUrl, 'http://watchtower:8080');
      assert.equal(cfg.watchtowerToken, 'wt_from_file');
      assert.equal(cfg.watchtowerTokenSource, 'file');
      assert.equal(cfg.watchtowerContainer, 'my-app');
      assert.equal(cfg.watchtowerTimeoutMs, 45_000);

      // Missing token when WATCHTOWER_URL is set
      const emptyDir = makeTempDir();
      try {
        assert.throws(
          () =>
            loadConfig({
              GIT_REPO: 'https://github.com/user/repo.git',
              WATCHTOWER_URL: 'http://watchtower:8080',
              SECRETS_DIR: emptyDir,
            }),
          /Watchtower token is required/,
        );
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }

      // Invalid URL scheme
      assert.throws(
        () =>
          loadConfig({
            GIT_REPO: 'https://github.com/user/repo.git',
            WATCHTOWER_URL: 'ftp://watchtower:8080',
            WATCHTOWER_TOKEN: 'tok',
            SECRETS_DIR: tmp,
          }),
        /Invalid WATCHTOWER_URL/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('matchesTagPattern', () => {
  it('matches glob patterns (* and ?) safely', () => {
    assert.equal(matchesTagPattern('v1.2.3', ['v*']), true);
    assert.equal(matchesTagPattern('release-2026.1', ['v*', 'release-*']), true);
    assert.equal(matchesTagPattern('beta-1', ['v*', 'release-*']), false);
    assert.equal(matchesTagPattern('v1.0', ['v?.?']), true);
    assert.equal(matchesTagPattern('v10.0', ['v?.?']), false);
    assert.equal(matchesTagPattern('v1x0', ['v1.0']), false); // literal dot escaped
    assert.equal(matchesTagPattern('anything', ['*']), true);
    assert.equal(matchesTagPattern('v1.0.0', []), false);
  });
});

describe('parseDockerBuildFlags', () => {
  it('splits flags with optional quotes and passes unknown/malformed inputs through for docker to validate', () => {
    assert.deepEqual(parseDockerBuildFlags(undefined), []);
    assert.deepEqual(parseDockerBuildFlags('   '), []);
    assert.deepEqual(parseDockerBuildFlags('--target ab-hive-aio\n--no-cache'), [
      '--target',
      'ab-hive-aio',
      '--no-cache',
    ]);
    assert.deepEqual(parseDockerBuildFlags('--build-arg MSG="hello world" --build-arg EMPTY=""'), [
      '--build-arg',
      'MSG=hello world',
      '--build-arg',
      'EMPTY=',
    ]);
    assert.deepEqual(parseDockerBuildFlags('--build-arg "unclosed'), ['--build-arg', '"unclosed']);
  });
});
