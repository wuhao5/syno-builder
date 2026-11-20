import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runCommand } from '../src/exec.js';

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runCommand', () => {
  it('returns immediately when passed an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const res = await runCommand(process.execPath, ['-e', 'process.exit(0)'], {
      signal: controller.signal,
    });
    assert.equal(res.aborted, true);
    assert.equal(res.timedOut, false);
    assert.equal(res.exitCode, 130);
  });

  it('terminates a stalled command when timeoutMs expires', async () => {
    const startedAt = Date.now();
    const res = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 150,
      killGraceMs: 500,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(res.timedOut, true);
    assert.equal(res.aborted, false);
    assert.notEqual(res.exitCode, 0);
    assert.ok(elapsedMs < 3000, `Expected quick timeout termination, took ${elapsedMs}ms`);
  });

  it('cancels an active command via AbortSignal and terminates its process group', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-builder-exec-'));
    const pidFile = path.join(tmp, 'grandchild.pid');
    const controller = new AbortController();

    try {
      // Spawn a shell that spawns a background sleep grandchild and records its PID
      const promise = runCommand(
        '/bin/sh',
        ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`],
        {
          signal: controller.signal,
          killGraceMs: 500,
        },
      );

      // Wait until the grandchild PID file appears
      let grandchildPid = 0;
      for (let i = 0; i < 50; i += 1) {
        if (fs.existsSync(pidFile)) {
          const content = fs.readFileSync(pidFile, 'utf8').trim();
          if (content) {
            grandchildPid = Number.parseInt(content, 10);
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(grandchildPid > 0, 'Expected grandchild process to start');

      controller.abort();
      const res = await promise;

      assert.equal(res.aborted, true);
      assert.equal(res.timedOut, false);

      // Give OS a brief tick to finalize process group cleanup
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(isPidAlive(grandchildPid), false, 'Expected grandchild process to be terminated');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
