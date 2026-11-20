import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig, normalizeWebhookPath } from '../src/config.js';

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
      assert.equal(cfg.checkIntervalMinutes, 60);
      assert.equal(cfg.gitTimeoutMs, 300_000);
      assert.equal(cfg.buildTimeoutMs, 1_800_000);
      assert.equal(cfg.dockerfilePath, '.');
      assert.equal(cfg.dockerImageName, 'auto-built-image');
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
});
