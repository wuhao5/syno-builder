import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildGitAuthEnv, normalizeRepoUrl } from '../src/git.js';
import { getStateFilePath, readLastCommit, sanitizeBranch, writeLastCommit } from '../src/state.js';

describe('normalizeRepoUrl', () => {
  it('normalizes HTTPS, HTTP, SSH, and SCP git URLs to a canonical value', () => {
    assert.equal(
      normalizeRepoUrl('https://github.com/Wuhao5/Syno-Builder.git'),
      'github.com/wuhao5/syno-builder',
    );
    assert.equal(
      normalizeRepoUrl('https://github.com/wuhao5/syno-builder/'),
      'github.com/wuhao5/syno-builder',
    );
    assert.equal(
      normalizeRepoUrl('git@github.com:wuhao5/syno-builder.git'),
      'github.com/wuhao5/syno-builder',
    );
    assert.equal(
      normalizeRepoUrl('ssh://git@github.com/wuhao5/syno-builder.git'),
      'github.com/wuhao5/syno-builder',
    );
    assert.equal(
      normalizeRepoUrl('https://oauth2:ghp_token@github.com/wuhao5/syno-builder.git'),
      'github.com/wuhao5/syno-builder',
    );
  });
});

describe('buildGitAuthEnv', () => {
  it('injects scoped Authorization header via GIT_CONFIG_* env vars', () => {
    const env = buildGitAuthEnv('https://github.com/user/private-repo.git', 'ghp_abc123', {});
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_CONFIG_COUNT, '1');
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraHeader');
    assert.equal(
      env.GIT_CONFIG_VALUE_0,
      `Authorization: Basic ${Buffer.from('oauth2:ghp_abc123').toString('base64')}`,
    );
  });

  it('omits Authorization header when no PAT is set', () => {
    const env = buildGitAuthEnv('https://github.com/user/public-repo.git', '', {});
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
  });
});

describe('state persistence', () => {
  it('reads and writes commit hashes with slash-safe filenames', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-builder-state-'));
    try {
      assert.equal(sanitizeBranch('main'), 'main');
      assert.equal(sanitizeBranch('feature/webhook-mode'), 'feature-webhook-mode');
      assert.equal(
        getStateFilePath(tmp, 'main'),
        path.join(tmp, 'last_commit_main.txt'),
      );

      assert.equal(readLastCommit(tmp, 'feature/webhook-mode'), null);
      writeLastCommit(tmp, 'feature/webhook-mode', 'abcdef1234567890');
      assert.equal(readLastCommit(tmp, 'feature/webhook-mode'), 'abcdef1234567890');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
