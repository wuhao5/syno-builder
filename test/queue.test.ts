import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BuildQueue } from '../src/queue.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('BuildQueue', () => {
  it('serializes builds and coalesces duplicate pushes for the same branch', async () => {
    let activeCount = 0;
    let maxConcurrency = 0;
    const calls: Array<{ branch: string; reason: string }> = [];

    let releaseFirstBuild: (() => void) | null = null;

    const queue = new BuildQueue(async (branch, reason) => {
      activeCount += 1;
      maxConcurrency = Math.max(maxConcurrency, activeCount);
      calls.push({ branch, reason });

      if (calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstBuild = resolve;
        });
      } else {
        await delay(5);
      }

      activeCount -= 1;
    });

    // Start first build on main
    queue.enqueue(['main'], 'webhook');
    await delay(10);
    assert.equal(queue.isRunning(), true);
    assert.equal(queue.getActiveBranch(), 'main');

    // Enqueue 3 rapid pushes to main + 1 to develop while first build is running
    const r1 = queue.enqueue(['main'], 'webhook');
    const r2 = queue.enqueue(['main'], 'webhook');
    const r3 = queue.enqueue(['develop'], 'webhook');
    const r4 = queue.enqueue(['main'], 'poll');

    assert.deepEqual(r1, { queued: ['main'], coalesced: [] });
    assert.deepEqual(r2, { queued: [], coalesced: ['main'] });
    assert.deepEqual(r3, { queued: ['develop'], coalesced: [] });
    assert.deepEqual(r4, { queued: [], coalesced: ['main'] });
    assert.deepEqual(queue.getPendingBranches(), ['main', 'develop']);

    // Release first build and wait for queue to drain
    releaseFirstBuild!();
    await queue.waitForIdle();

    assert.equal(maxConcurrency, 1);
    assert.equal(queue.isRunning(), false);
    // main ran initially, then coalesced into a single follow-up, plus develop once
    assert.deepEqual(calls, [
      { branch: 'main', reason: 'webhook' },
      { branch: 'main', reason: 'poll' },
      { branch: 'develop', reason: 'webhook' },
    ]);
  });

  it('isolates errors so subsequent branches still build', async () => {
    const executed: string[] = [];
    const queue = new BuildQueue(async (branch) => {
      executed.push(branch);
      if (branch === 'broken') {
        throw new Error('simulated build crash');
      }
    });

    queue.enqueue(['broken', 'healthy'], 'poll');
    await queue.waitForIdle();

    assert.deepEqual(executed, ['broken', 'healthy']);
  });
});
