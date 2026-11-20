import { logger } from './logger.js';

export type BuildHandler = (branch: string, reason: string) => Promise<void>;

export interface EnqueueResult {
  queued: string[];
  coalesced: string[];
}

/**
 * Single-flight build queue that serializes git/docker operations across
 * branches and coalesces duplicate triggers for the same branch.
 */
export class BuildQueue {
  private readonly pending = new Map<string, string>();
  private running = false;
  private stopped = false;
  private activeBranch: string | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly handler: BuildHandler) {}

  enqueue(branches: string[], reason: string): EnqueueResult {
    const queued: string[] = [];
    const coalesced: string[] = [];

    if (this.stopped) {
      logger.warn(`Ignoring enqueue (${reason}) because queue is shutting down.`);
      return { queued, coalesced };
    }

    for (const branch of branches) {
      if (this.pending.has(branch)) {
        this.pending.set(branch, reason);
        coalesced.push(branch);
      } else {
        this.pending.set(branch, reason);
        queued.push(branch);
      }
    }

    if (!this.running && this.pending.size > 0) {
      this.drainPromise = this.drain();
    }

    return { queued, coalesced };
  }

  isRunning(): boolean {
    return this.running;
  }

  getActiveBranch(): string | null {
    return this.activeBranch;
  }

  getPendingBranches(): string[] {
    return Array.from(this.pending.keys());
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
  }

  async waitForIdle(): Promise<void> {
    if (this.drainPromise) {
      await this.drainPromise;
    }
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (!this.stopped && this.pending.size > 0) {
        const nextEntry = this.pending.entries().next();
        if (nextEntry.done) {
          break;
        }
        const [branch, reason] = nextEntry.value;
        this.pending.delete(branch);
        this.activeBranch = branch;

        try {
          await this.handler(branch, reason);
        } catch (err) {
          logger.error(
            `Unhandled error processing branch "${branch}" (trigger: ${reason}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        } finally {
          this.activeBranch = null;
        }
      }
    } finally {
      this.running = false;
      this.drainPromise = null;
    }
  }
}
