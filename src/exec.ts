import { spawn, type ChildProcess } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  captureStdout?: boolean;
  timeoutMs?: number;
  killGraceMs?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
  aborted: boolean;
  terminationSignal: NodeJS.Signals | null;
}

const DEFAULT_KILL_GRACE_MS = 5_000;

function killProcessTree(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  // On POSIX with detached: true, child is the leader of its own process group (-pid),
  // so signaling -pid terminates both the command and any subprocesses it spawned.
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      // Fall back to signaling the direct child PID
    }
  }

  try {
    child.kill(sig);
  } catch {
    // Process already exited
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      exitCode: 130,
      stdout: '',
      timedOut: false,
      aborted: true,
      terminationSignal: null,
    });
  }

  return new Promise((resolve, reject) => {
    const capture = options.captureStdout === true;
    const useProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: useProcessGroup,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    });

    const chunks: Buffer[] = [];
    if (capture && child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

    const terminate = (reason: 'timeout' | 'abort'): void => {
      if (settled) {
        return;
      }
      if (reason === 'timeout') {
        timedOut = true;
      } else {
        aborted = true;
      }

      killProcessTree(child, 'SIGTERM');

      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          if (!settled) {
            killProcessTree(child, 'SIGKILL');
          }
        }, killGraceMs);
        forceKillTimer.unref();
      }
    };

    const onAbort = (): void => {
      terminate('abort');
    };

    const cleanup = (): void => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
    };

    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        terminate('timeout');
      }, options.timeoutMs);
      timeoutTimer.unref();
    }

    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const stdout = capture ? Buffer.concat(chunks).toString('utf8') : '';
      const exitCode = code ?? (timedOut ? 124 : aborted ? 130 : 128);
      resolve({
        exitCode,
        stdout,
        timedOut,
        aborted,
        terminationSignal: signal,
      });
    });
  });
}
