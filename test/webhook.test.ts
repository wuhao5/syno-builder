import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import type { Config } from '../src/config.js';
import {
  parseWebhookPayload,
  startWebhookServer,
  verifyGitHubSignature,
} from '../src/webhook.js';

function sign(secret: string, body: string): string {
  const digest = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    gitRepo: 'https://github.com/wuhao5/myapp.git',
    gitBranches: ['main', 'develop'],
    gitPat: '',
    gitPatSource: 'none',
    gitPatFile: '/app/secrets/pat',
    triggerMode: 'webhook',
    runOnStartup: false,
    checkIntervalMinutes: 60,
    gitTimeoutMs: 300_000,
    buildTimeoutMs: 1_800_000,
    composeTimeoutMs: 300_000,
    dockerfilePath: '.',
    dockerImageName: 'myapp',
    dockerBuildFlags: [],
    shouldTagEachBuild: false,
    composeServices: [],
    webhookPort: 0,
    webhookHost: '127.0.0.1',
    webhookPath: '/webhook',
    webhookSecret: 'test-webhook-secret-123',
    webhookSecretSource: 'env',
    webhookSecretFile: '/app/secrets/webhook_secret',
    repoDir: '/tmp/repo',
    stateDir: '/tmp/state',
    secretsDir: '/tmp/secrets',
    ...overrides,
  };
}

describe('verifyGitHubSignature', () => {
  it('accepts valid HMAC-SHA256 signatures and rejects tampered/malformed ones', () => {
    const secret = 'my-secret';
    const raw = Buffer.from('{"ref":"refs/heads/main"}', 'utf8');
    const valid = sign(secret, raw.toString('utf8'));

    assert.equal(verifyGitHubSignature(secret, raw, valid), true);
    assert.equal(verifyGitHubSignature(secret, raw, valid.toUpperCase()), true);
    assert.equal(verifyGitHubSignature('wrong-secret', raw, valid), false);
    assert.equal(verifyGitHubSignature(secret, Buffer.from('tampered'), valid), false);
    assert.equal(verifyGitHubSignature(secret, raw, undefined), false);
    assert.equal(verifyGitHubSignature(secret, raw, 'sha1=deadbeef'), false);
    assert.equal(verifyGitHubSignature(secret, raw, 'sha256=not-hex'), false);
  });
});

describe('parseWebhookPayload', () => {
  it('parses both application/json and form-urlencoded GitHub payloads', () => {
    const jsonPayload = '{"ref":"refs/heads/main"}';
    assert.deepEqual(
      parseWebhookPayload(Buffer.from(jsonPayload), 'application/json'),
      { ref: 'refs/heads/main' },
    );

    const formBody = `payload=${encodeURIComponent(jsonPayload)}`;
    assert.deepEqual(
      parseWebhookPayload(
        Buffer.from(formBody),
        'application/x-www-form-urlencoded; charset=utf-8',
      ),
      { ref: 'refs/heads/main' },
    );

    assert.equal(parseWebhookPayload(Buffer.from('not-json'), 'application/json'), null);
  });
});

describe('webhook HTTP server', () => {
  it('handles /health, ping, signed push, branch/repo filtering, and error responses', async () => {
    const received: Array<{ branch: string; commit?: string }> = [];
    const cfg = makeTestConfig();
    const server = await startWebhookServer({
      config: cfg,
      maxBodyBytes: 4096,
      onPush(branch, meta) {
        received.push({ branch, commit: meta.commit });
      },
    });

    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      // GET /health
      const healthRes = await fetch(`${baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      assert.deepEqual(await healthRes.json(), { status: 'ok' });

      // 404 unknown path
      const notFoundRes = await fetch(`${baseUrl}/unknown`);
      assert.equal(notFoundRes.status, 404);

      // 405 GET on /webhook
      const methodRes = await fetch(`${baseUrl}/webhook`);
      assert.equal(methodRes.status, 405);

      // 401 missing signature
      const unauthRes = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'ping',
        },
        body: '{}',
      });
      assert.equal(unauthRes.status, 401);

      // 200 ping
      const pingBody = JSON.stringify({ zen: 'Keep it logically awesome.' });
      const pingRes = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'ping',
          'X-GitHub-Delivery': 'delivery-ping',
          'X-Hub-Signature-256': sign(cfg.webhookSecret, pingBody),
        },
        body: pingBody,
      });
      assert.equal(pingRes.status, 200);
      assert.deepEqual(await pingRes.json(), { status: 'pong' });

      // 202 valid push to tracked branch
      const pushBody = JSON.stringify({
        ref: 'refs/heads/develop',
        after: 'abcdef1234567890abcdef1234567890abcdef12',
        deleted: false,
        repository: {
          clone_url: 'https://github.com/wuhao5/myapp.git',
          html_url: 'https://github.com/wuhao5/myapp',
        },
      });
      const pushRes = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'push',
          'X-GitHub-Delivery': 'delivery-1',
          'X-Hub-Signature-256': sign(cfg.webhookSecret, pushBody),
        },
        body: pushBody,
      });
      assert.equal(pushRes.status, 202);
      assert.deepEqual(await pushRes.json(), {
        status: 'queued',
        branch: 'develop',
        commit: 'abcdef1',
      });
      assert.deepEqual(received, [
        { branch: 'develop', commit: 'abcdef1234567890abcdef1234567890abcdef12' },
      ]);

      // 200 ignored: untracked branch
      const untrackedBody = JSON.stringify({
        ref: 'refs/heads/other-branch',
        after: '1234567890abcdef1234567890abcdef12345678',
        repository: { clone_url: 'https://github.com/wuhao5/myapp.git' },
      });
      const untrackedRes = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'push',
          'X-Hub-Signature-256': sign(cfg.webhookSecret, untrackedBody),
        },
        body: untrackedBody,
      });
      assert.equal(untrackedRes.status, 200);
      assert.deepEqual(await untrackedRes.json(), {
        status: 'ignored',
        reason: 'untracked branch',
      });

      // 200 ignored: tag push
      const tagBody = JSON.stringify({
        ref: 'refs/tags/v1.0.0',
        after: '1234567890abcdef1234567890abcdef12345678',
        repository: { clone_url: 'https://github.com/wuhao5/myapp.git' },
      });
      const tagRes = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'push',
          'X-Hub-Signature-256': sign(cfg.webhookSecret, tagBody),
        },
        body: tagBody,
      });
      assert.equal(tagRes.status, 200);
      assert.deepEqual(await tagRes.json(), {
        status: 'ignored',
        reason: 'non-branch ref',
      });

      // 200 ignored: branch deleted
      const deletedBody = JSON.stringify({
        ref: 'refs/heads/develop',
        after: '0000000000000000000000000000000000000000',
        deleted: true,
        repository: { clone_url: 'https://github.com/wuhao5/myapp.git' },
      });
      const deletedRes = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'push',
          'X-Hub-Signature-256': sign(cfg.webhookSecret, deletedBody),
        },
        body: deletedBody,
      });
      assert.equal(deletedRes.status, 200);
      assert.deepEqual(await deletedRes.json(), {
        status: 'ignored',
        reason: 'branch deleted',
      });

      // 200 ignored: repository mismatch
      const wrongRepoBody = JSON.stringify({
        ref: 'refs/heads/main',
        after: '1234567890abcdef1234567890abcdef12345678',
        repository: { clone_url: 'https://github.com/someone/other-repo.git' },
      });
      const wrongRepoRes = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'push',
          'X-Hub-Signature-256': sign(cfg.webhookSecret, wrongRepoBody),
        },
        body: wrongRepoBody,
      });
      assert.equal(wrongRepoRes.status, 200);
      assert.deepEqual(await wrongRepoRes.json(), {
        status: 'ignored',
        reason: 'repository mismatch',
      });

      // 413 payload too large
      const hugeBody = JSON.stringify({ padding: 'x'.repeat(5000) });
      const hugeRes = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'push',
          'X-Hub-Signature-256': sign(cfg.webhookSecret, hugeBody),
        },
        body: hugeBody,
      });
      assert.equal(hugeRes.status, 413);

      // Only the single valid push should have fired onPush
      assert.equal(received.length, 1);
    } finally {
      await server.close();
    }
  });
});
