import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { runCommand } from './exec.js';
import { syncBranch } from './git.js';
import { logger } from './logger.js';
import { readLastCommit, sanitizeBranch, writeLastCommit } from './state.js';

export interface BuildSecret {
  id: string;
  src: string;
}

export interface BuildMetadata {
  branch: string;
  branchSafe: string;
  commitHash: string;
  commitShort: string;
  buildTimestamp: string;
  buildContext: string;
  dockerfileFullPath: string;
  imageTag?: string;
  imageBranch: string;
  imageLatest?: string;
}

export type BranchBuildOutcome = 'unchanged' | 'built' | 'failed' | 'aborted';

export function formatBuildTimestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export function computeBuildMetadata(
  config: Config,
  branch: string,
  commitHash: string,
  now: Date = new Date(),
): BuildMetadata {
  const branchSafe = sanitizeBranch(branch);
  const commitShort = commitHash.slice(0, 7);
  const buildTimestamp = formatBuildTimestamp(now);
  const buildContext = path.resolve(config.repoDir, config.dockerfilePath);
  const dockerfileFullPath = path.join(buildContext, 'Dockerfile');

  let imageTag: string | undefined;
  if (config.imageTag) {
    imageTag = config.imageTag;
  } else if (config.shouldTagEachBuild) {
    imageTag = `${config.dockerImageName}:${branchSafe}-${commitShort}`;
  }

  const imageBranch = `${config.dockerImageName}:${branchSafe}`;
  const imageLatest =
    branch === 'main' || branch === 'master'
      ? `${config.dockerImageName}:latest`
      : undefined;

  return {
    branch,
    branchSafe,
    commitHash,
    commitShort,
    buildTimestamp,
    buildContext,
    dockerfileFullPath,
    imageTag,
    imageBranch,
    imageLatest,
  };
}

export function discoverBuildSecrets(
  secretsDir: string,
  reservedFilePaths: string[] = [],
): BuildSecret[] {
  if (!fs.existsSync(secretsDir)) {
    return [];
  }

  const resolvedSecretsDir = path.resolve(secretsDir);
  const excludedNames = new Set<string>(['pat', 'webhook_secret']);

  for (const filePath of reservedFilePaths) {
    if (!filePath) continue;
    const resolved = path.resolve(filePath);
    if (path.dirname(resolved) === resolvedSecretsDir) {
      excludedNames.add(path.basename(resolved));
    }
  }

  const entries = fs.readdirSync(resolvedSecretsDir).sort();
  const secrets: BuildSecret[] = [];

  for (const entry of entries) {
    if (entry.startsWith('.') || excludedNames.has(entry)) {
      continue;
    }
    const fullPath = path.join(resolvedSecretsDir, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        secrets.push({ id: entry, src: fullPath });
      }
    } catch {
      // Skip unreadable/broken symlinks
    }
  }

  return secrets;
}

export function createBuildScriptEnv(
  config: Config,
  metadata: BuildMetadata,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    BUILD_CONTEXT: metadata.buildContext,
    DOCKERFILE_FULL_PATH: metadata.dockerfileFullPath,
    IMAGE_TAG: metadata.imageTag ?? '',
    IMAGE_BRANCH: metadata.imageBranch,
    IMAGE_LATEST: metadata.imageLatest ?? '',
    BRANCH: metadata.branch,
    BRANCH_SAFE: metadata.branchSafe,
    DOCKER_IMAGE_NAME: config.dockerImageName,
    GIT_COMMIT_HASH: metadata.commitHash,
    GIT_COMMIT_SHORT: metadata.commitShort,
    GIT_BRANCH_NAME: metadata.branch,
    GIT_REPO_URL: config.gitRepo,
    BUILD_TIMESTAMP: metadata.buildTimestamp,
    REPO_DIR: config.repoDir,
  };
}

export function hasCustomDockerfileFlag(flags: string[]): boolean {
  return flags.some(
    (flag) =>
      flag === '-f' ||
      flag === '--file' ||
      flag.startsWith('--file=') ||
      (flag.startsWith('-f') && flag.length > 2),
  );
}

export function buildDockerArgs(
  config: Config,
  metadata: BuildMetadata,
  secrets: BuildSecret[],
): string[] {
  const args: string[] = [
    'buildx',
    'build',
    '--build-arg',
    `GIT_COMMIT_HASH=${metadata.commitHash}`,
    '--build-arg',
    `GIT_COMMIT_SHORT=${metadata.commitShort}`,
    '--build-arg',
    `GIT_BRANCH=${metadata.branch}`,
    '--build-arg',
    `GIT_REPO=${config.gitRepo}`,
    '--build-arg',
    `BUILD_TIMESTAMP=${metadata.buildTimestamp}`,
  ];

  for (const secret of secrets) {
    args.push('--secret', `id=${secret.id},src=${secret.src}`);
  }

  if (config.dockerBuildFlags.length > 0) {
    args.push(...config.dockerBuildFlags);
  }

  if (metadata.imageTag) {
    args.push('-t', metadata.imageTag);
  }
  args.push('-t', metadata.imageBranch);
  args.push(metadata.buildContext);

  return args;
}

function tryChmodExecutable(scriptPath: string): void {
  try {
    fs.chmodSync(scriptPath, 0o755);
  } catch {
    // Ignore errors on read-only mounts
  }
}

function resolvePostBuildLogPath(): string {
  try {
    fs.accessSync('/var/log', fs.constants.W_OK);
    return '/var/log/post-build.log';
  } catch {
    return '/tmp/post-build.log';
  }
}

function launchPostBuildScript(
  scriptPath: string,
  env: NodeJS.ProcessEnv,
): void {
  if (!fs.existsSync(scriptPath)) {
    logger.warn(`POST_BUILD_SCRIPT is set but file not found: ${scriptPath}`);
    return;
  }

  logger.info(`Running post-build script (detached): ${scriptPath}`);
  tryChmodExecutable(scriptPath);

  const logPath = resolvePostBuildLogPath();
  const logFd = fs.openSync(logPath, 'w');

  try {
    const child = spawn(scriptPath, [], {
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.on('error', (err) => {
      logger.error(`Failed to launch post-build script ${scriptPath}: ${err.message}`);
    });
    child.unref();
    logger.info(`Post-build script started with PID ${child.pid ?? 'unknown'} (logs: ${logPath})`);
  } finally {
    fs.closeSync(logFd);
  }
}

export function shouldDeployCompose(config: Config, branch: string): boolean {
  if (!config.composeProjectDir) {
    return false;
  }
  if (config.composeBranch && config.composeBranch !== branch) {
    return false;
  }
  return true;
}

export function buildComposeArgs(config: Config): string[] {
  const args: string[] = ['compose'];
  if (config.composeProjectName) {
    args.push('-p', config.composeProjectName);
  }
  if (config.composeFile) {
    args.push('-f', config.composeFile);
  }
  args.push('up', '-d', '--no-build');
  if (config.composeServices.length > 0) {
    args.push('--no-deps', ...config.composeServices);
  }
  return args;
}

export async function deployComposeProject(
  config: Config,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!config.composeProjectDir) {
    return true;
  }

  if (!fs.existsSync(config.composeProjectDir)) {
    logger.error(
      `COMPOSE_PROJECT_DIR not found at ${config.composeProjectDir}. Ensure your Synology Container Manager project directory is mounted at the exact same path inside the container.`,
    );
    return false;
  }

  const composeArgs = buildComposeArgs(config);
  logger.info(
    `Redeploying Docker Compose project in ${config.composeProjectDir} for branch "${branch}": docker ${composeArgs.join(' ')}`,
  );

  const res = await runCommand('docker', composeArgs, {
    cwd: config.composeProjectDir,
    timeoutMs: config.composeTimeoutMs,
    signal,
  });

  if (res.aborted) {
    logger.warn(`Docker Compose redeploy aborted for branch "${branch}" due to shutdown.`);
    return false;
  }

  if (res.timedOut) {
    logger.error(
      `Docker Compose redeploy timed out for branch "${branch}" after ${Math.round(config.composeTimeoutMs / 1000)}s.`,
    );
    return false;
  }

  if (res.exitCode !== 0) {
    logger.error(
      `Docker Compose redeploy failed for branch "${branch}" (exit code: ${res.exitCode})`,
    );
    return false;
  }

  logger.info(`Docker Compose project redeployed successfully for branch "${branch}"!`);
  return true;
}

export async function buildDockerImage(
  config: Config,
  branch: string,
  commitHash: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const metadata = computeBuildMetadata(config, branch, commitHash);

  if (!fs.existsSync(metadata.buildContext)) {
    logger.error(`Build context directory not found at ${metadata.buildContext}`);
    return false;
  }

  const usesCustomDockerfile =
    !config.buildScript && hasCustomDockerfileFlag(config.dockerBuildFlags);
  if (!usesCustomDockerfile && !fs.existsSync(metadata.dockerfileFullPath)) {
    logger.error(`Dockerfile not found at ${metadata.dockerfileFullPath}`);
    return false;
  }

  logger.info(`Building Docker image from ${metadata.buildContext}...`);
  if (metadata.imageTag) {
    logger.info(`Image tag: ${metadata.imageTag}`);
  } else {
    logger.info(`Per-build commit tagging disabled (SHOULD_TAG_EACH_BUILD=${config.shouldTagEachBuild})`);
  }

  const secrets = discoverBuildSecrets(config.secretsDir, [
    config.gitPatFile,
    config.webhookSecretFile,
  ]);
  if (secrets.length > 0) {
    logger.info(`Mounting ${secrets.length} BuildKit secret(s): ${secrets.map((s) => s.id).join(', ')}`);
  }

  const scriptEnv = createBuildScriptEnv(config, metadata);
  const buildExecOptions = {
    timeoutMs: config.buildTimeoutMs,
    signal,
  };

  let buildResult: { exitCode: number; timedOut: boolean; aborted: boolean };

  if (config.buildScript) {
    if (!fs.existsSync(config.buildScript)) {
      logger.error(`BUILD_SCRIPT is set but file not found: ${config.buildScript}`);
      return false;
    }
    logger.info(`Using custom build script: ${config.buildScript}`);
    tryChmodExecutable(config.buildScript);
    buildResult = await runCommand(config.buildScript, [], {
      ...buildExecOptions,
      env: scriptEnv,
    });
  } else {
    logger.info('Using default docker buildx build command');
    if (config.dockerBuildFlags.length > 0) {
      logger.info(`Build flags: ${config.dockerBuildFlags.join(' ')}`);
    }
    const dockerArgs = buildDockerArgs(config, metadata, secrets);
    buildResult = await runCommand('docker', dockerArgs, {
      ...buildExecOptions,
      cwd: metadata.buildContext,
    });
  }

  if (buildResult.aborted) {
    logger.warn(`Docker build aborted for branch "${branch}" due to shutdown.`);
    return false;
  }

  if (buildResult.timedOut) {
    logger.error(
      `Docker build timed out for branch "${branch}" after ${Math.round(config.buildTimeoutMs / 1000)}s.`,
    );
    return false;
  }

  if (buildResult.exitCode !== 0) {
    logger.error(`Docker build failed for branch "${branch}" (exit code: ${buildResult.exitCode})`);
    return false;
  }

  logger.info(`Build successful for branch "${branch}"!`);
  if (metadata.imageTag) {
    logger.info(`Tagged as: ${metadata.imageTag}`);
  }
  logger.info(`Tagged as: ${metadata.imageBranch}`);

  if (metadata.imageLatest) {
    if (!config.buildScript) {
      const tagRes = await runCommand(
        'docker',
        ['tag', metadata.imageBranch, metadata.imageLatest],
        { timeoutMs: 60_000, signal },
      );
      if (tagRes.exitCode === 0) {
        logger.info(`Tagged as: ${metadata.imageLatest}`);
      } else {
        logger.warn(`Failed to tag ${metadata.imageLatest} (exit code: ${tagRes.exitCode})`);
      }
    } else {
      logger.info(`Latest tag (if created by build script): ${metadata.imageLatest}`);
    }
  }

  if (signal?.aborted) {
    logger.warn(`Skipping post-build actions for branch "${branch}" due to shutdown.`);
    return false;
  }

  if (shouldDeployCompose(config, branch)) {
    const deployed = await deployComposeProject(config, branch, signal);
    if (!deployed) {
      return false;
    }
  } else if (config.composeProjectDir && config.composeBranch) {
    logger.info(
      `Skipping Docker Compose redeploy for branch "${branch}" (COMPOSE_BRANCH=${config.composeBranch})`,
    );
  }

  if (signal?.aborted) {
    logger.warn(`Skipping post-build script for branch "${branch}" due to shutdown.`);
    return false;
  }

  if (config.postBuildScript) {
    launchPostBuildScript(config.postBuildScript, scriptEnv);
  }

  return true;
}

export async function checkAndBuildBranch(
  config: Config,
  branch: string,
  signal?: AbortSignal,
): Promise<BranchBuildOutcome> {
  if (signal?.aborted) {
    return 'aborted';
  }

  logger.info(`--- Processing branch: ${branch} ---`);

  let currentCommit: string;
  try {
    currentCommit = await syncBranch(config, branch, signal);
  } catch (err) {
    if (signal?.aborted) {
      logger.warn(`Git sync aborted for branch "${branch}" due to shutdown.`);
      return 'aborted';
    }
    logger.error(
      `Git sync failed for branch "${branch}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'failed';
  }

  logger.info(`Current commit on "${branch}": ${currentCommit}`);

  const lastCommit = readLastCommit(config.stateDir, branch);
  if (lastCommit) {
    logger.info(`Last processed commit on "${branch}": ${lastCommit}`);
    if (currentCommit === lastCommit) {
      logger.info(`No changes detected on branch "${branch}". Skipping build.`);
      return 'unchanged';
    }
  } else {
    logger.info(`First run for branch "${branch}" — no previous commit recorded.`);
  }

  logger.info(`Changes detected on branch "${branch}"! Starting Docker build...`);

  try {
    const success = await buildDockerImage(config, branch, currentCommit, signal);
    if (signal?.aborted) {
      return 'aborted';
    }
    if (!success) {
      return 'failed';
    }
    writeLastCommit(config.stateDir, branch, currentCommit);
    logger.info(`Saved commit ${currentCommit} to state for branch "${branch}".`);
    return 'built';
  } catch (err) {
    if (signal?.aborted) {
      return 'aborted';
    }
    logger.error(
      `Unexpected error building branch "${branch}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'failed';
  }
}
