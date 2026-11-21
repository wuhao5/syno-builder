import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import type { Config } from '../src/config.js';
import {
  buildWatchtowerUpdateUrl,
  extractPackageImageRef,
  triggerWatchtowerUpdate,
} from '../src/watchtower.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    gitRepo: 'https://github.com/wuhao5/myapp.git',
    gitBranches: ['main'],
    gitTagPatterns: [],
    tagLatest: true,
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
    watchtowerUrl: 'http://127.0.0.1:8080',
    watchtowerToken: 'wt-secret-token',
    watchtowerTokenSource: 'env',
    watchtowerTokenFile: '/app/secrets/watchtower_token',
    watchtowerTimeoutMs: 5_000,
    webhookPort: 9000,
    webhookHost: '127.0.0.1',
    webhookPath: '/webhook',
    webhookSecret: 'gh-secret',
    webhookSecretSource: 'env',
    webhookSecretFile: '/app/secrets/webhook_secret',
    repoDir: '/tmp/repo',
    stateDir: '/tmp/state',
    secretsDir: '/tmp/secrets',
    ...overrides,
  };
}

describe('buildWatchtowerUpdateUrl', () => {
  it('appends /v1/update and optional image/container query parameters', () => {
    assert.equal(
      buildWatchtowerUpdateUrl('http://watchtower:8080/'),
      'http://watchtower:8080/v1/update',
    );
    assert.equal(
      buildWatchtowerUpdateUrl('http://watchtower:8080', { image: 'myapp:latest' }),
      'http://watchtower:8080/v1/update?image=myapp%3Alatest',
    );
    assert.equal(
      buildWatchtowerUpdateUrl('http://watchtower:8080', { container: '^web$' }),
      'http://watchtower:8080/v1/update?container=%5Eweb%24',
    );
  });
});

describe('extractPackageImageRef', () => {
  it('extracts container image references from GitHub package webhook payloads', () => {
    assert.equal(
      extractPackageImageRef({
        package: {
          package_type: 'container',
          name: 'syno-builder',
          package_version: {
            package_url: 'ghcr.io/wuhao5/syno-builder:latest',
          },
        },
      }),
      'ghcr.io/wuhao5/syno-builder:latest',
    );

    // Digest-based package_url combined with container_metadata.tag.name
    assert.equal(
      extractPackageImageRef({
        package: {
          package_type: 'container',
          name: 'syno-builder',
          package_version: {
            package_url: 'ghcr.io/wuhao5/syno-builder@sha256:abcdef',
            container_metadata: { tag: { name: 'v1.2.3' } },
          },
        },
      }),
      'ghcr.io/wuhao5/syno-builder:v1.2.3',
    );

    // Namespace + name fallback
    assert.equal(
      extractPackageImageRef({
        package: {
          package_type: 'container',
          namespace: 'Wuhao5',
          name: 'MyApp',
          package_version: {
            container_metadata: { tag: { name: 'main' } },
          },
        },
      }),
      'ghcr.io/wuhao5/myapp:main',
    );

    // Non-container package (npm) ignored
    assert.equal(
      extractPackageImageRef({
        package: {
          package_type: 'npm',
          name: 'my-lib',
          package_version: { package_url: 'pkg:npm/my-lib@1.0.0' },
        },
      }),
      null,
    );
  });
});

describe('triggerWatchtowerUpdate', () => {
  it('POSTs to /v1/update with Bearer token and parses Watchtower JSON summary', async () => {
    let capturedMethod = '';
    let capturedUrl = '';
    let capturedAuth = '';
    let nextStatus = 200;

    const mockWatchtower = http.createServer((req, res) => {
      capturedMethod = req.method ?? '';
      capturedUrl = req.url ?? '';
      capturedAuth = req.headers.authorization ?? '';

      if (nextStatus !== 200) {
        res.writeHead(nextStatus, { 'Content-Type': 'text/plain' });
        res.end('unauthorized');
        return;
      }

      const body = JSON.stringify({
        summary: { scanned: 2, updated: 1, failed: 0 },
        api_version: 'v1',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });

    await new Promise<void>((resolve) => mockWatchtower.listen(0, '127.0.0.1', resolve));
    const port = (mockWatchtower.address() as AddressInfo).port;

    try {
      const cfg = makeConfig({
        watchtowerUrl: `http://127.0.0.1:${port}`,
        watchtowerToken: 'super-wt-token',
      });

      const okRes = await triggerWatchtowerUpdate(cfg, { image: 'myapp:latest' });
      assert.equal(okRes.ok, true);
      assert.equal(okRes.statusCode, 200);
      assert.deepEqual(okRes.summary, { scanned: 2, updated: 1, failed: 0 });
      assert.equal(capturedMethod, 'POST');
      assert.equal(capturedUrl, '/v1/update?image=myapp%3Alatest');
      assert.equal(capturedAuth, 'Bearer super-wt-token');

      nextStatus = 401;
      const errRes = await triggerWatchtowerUpdate(cfg, { image: 'myapp:latest' });
      assert.equal(errRes.ok, false);
      assert.equal(errRes.statusCode, 401);
    } finally {
      await new Promise<void>((resolve) => mockWatchtower.close(() => resolve()));
    }
  });
});
