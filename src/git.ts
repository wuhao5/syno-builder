import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { runCommand } from './exec.js';
import { logger } from './logger.js';

/**
 * Normalizes HTTP(S), SSH, and SCP-style git URLs into a canonical
 * lowercase "host/owner/repo" string for comparison.
 */
export function normalizeRepoUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  // Handle SCP-style syntax: git@github.com:owner/repo.git
  const scpMatch = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(trimmed);
  if (scpMatch && !trimmed.includes('://')) {
    const host = scpMatch[1]?.toLowerCase();
    const repoPath = scpMatch[2]
      ?.replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
    if (!host || !repoPath) {
      return null;
    }
    return `${host}/${repoPath}`;
  }

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const repoPath = parsed.pathname
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
    if (!host || !repoPath) {
      return null;
    }
    return `${host}/${repoPath}`;
  } catch {
    return null;
  }
}

/**
 * Builds an environment object for git child processes that passes HTTPS PAT
 * authentication via GIT_CONFIG_* variables without writing plaintext credentials
 * to disk or exposing them in process arguments.
 */
export function buildGitAuthEnv(
  gitRepo: string,
  gitPat: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: '0',
  };

  if (!gitPat) {
    return env;
  }

  try {
    const parsed = new URL(gitRepo);
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.password) {
      const origin = `${parsed.protocol}//${parsed.host}`;
      const existingCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
      const index = Number.isFinite(existingCount) && existingCount >= 0 ? existingCount : 0;
      const encoded = Buffer.from(`oauth2:${gitPat}`, 'utf8').toString('base64');

      env.GIT_CONFIG_COUNT = String(index + 1);
      env[`GIT_CONFIG_KEY_${index}`] = `http.${origin}/.extraHeader`;
      env[`GIT_CONFIG_VALUE_${index}`] = `Authorization: Basic ${encoded}`;
    }
  } catch {
    // Non-HTTP URL (e.g. SSH or local path) — leave auth untouched
  }

  return env;
}

export async function syncBranch(
  config: Config,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  const gitEnv = buildGitAuthEnv(config.gitRepo, config.gitPat);
  const gitDir = path.join(config.repoDir, '.git');
  const commonExec = {
    env: gitEnv,
    timeoutMs: config.gitTimeoutMs,
    signal,
  };

  const describeFailure = (action: string, res: { exitCode: number; timedOut: boolean; aborted: boolean }): Error => {
    if (res.aborted) {
      return new Error(`${action} aborted due to shutdown`);
    }
    if (res.timedOut) {
      return new Error(`${action} timed out after ${Math.round(config.gitTimeoutMs / 1000)}s`);
    }
    return new Error(`${action} (exit code: ${res.exitCode})`);
  };

  if (!fs.existsSync(gitDir)) {
    logger.info(`Cloning repository into ${config.repoDir} (branch: ${branch})...`);
    fs.mkdirSync(path.dirname(config.repoDir), { recursive: true });
    const cloneResult = await runCommand(
      'git',
      ['clone', '-b', branch, config.gitRepo, config.repoDir],
      commonExec,
    );
    if (cloneResult.exitCode !== 0) {
      throw describeFailure('Failed to clone repository', cloneResult);
    }
  }

  logger.info(`Fetching branch "${branch}" from origin...`);
  const fetchResult = await runCommand(
    'git',
    ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { cwd: config.repoDir, ...commonExec },
  );
  if (fetchResult.exitCode !== 0) {
    throw describeFailure(`Failed to fetch branch "${branch}"`, fetchResult);
  }

  const checkoutResult = await runCommand(
    'git',
    ['checkout', '-B', branch, `origin/${branch}`],
    { cwd: config.repoDir, ...commonExec },
  );
  if (checkoutResult.exitCode !== 0) {
    throw describeFailure(`Failed to checkout branch "${branch}"`, checkoutResult);
  }

  const resetResult = await runCommand(
    'git',
    ['reset', '--hard', `origin/${branch}`],
    { cwd: config.repoDir, ...commonExec },
  );
  if (resetResult.exitCode !== 0) {
    throw describeFailure(`Failed to reset branch "${branch}"`, resetResult);
  }

  const revResult = await runCommand(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: config.repoDir, ...commonExec, captureStdout: true },
  );
  if (revResult.exitCode !== 0) {
    throw describeFailure('Failed to read HEAD commit hash', revResult);
  }

  const commitHash = revResult.stdout.trim();
  if (!commitHash) {
    throw new Error(`Empty commit hash returned for branch "${branch}"`);
  }

  return commitHash;
}
