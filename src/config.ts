import fs from 'node:fs';
import path from 'node:path';

export type TriggerMode = 'poll' | 'webhook' | 'both';

export interface Config {
  gitRepo: string;
  gitBranches: string[];
  gitPat: string;
  gitPatSource: 'file' | 'env' | 'none';
  gitPatFile: string;
  triggerMode: TriggerMode;
  runOnStartup: boolean;
  checkIntervalMinutes: number;
  gitTimeoutMs: number;
  buildTimeoutMs: number;
  composeTimeoutMs: number;
  dockerfilePath: string;
  dockerImageName: string;
  dockerBuildFlags: string[];
  imageTag?: string;
  shouldTagEachBuild: boolean;
  buildScript?: string;
  postBuildScript?: string;
  composeProjectDir?: string;
  composeProjectName?: string;
  composeServices: string[];
  composeFile?: string;
  composeBranch?: string;
  webhookPort: number;
  webhookHost: string;
  webhookPath: string;
  webhookSecret: string;
  webhookSecretSource: 'file' | 'env' | 'none';
  webhookSecretFile: string;
  repoDir: string;
  stateDir: string;
  secretsDir: string;
}

export interface LoadConfigOptions {
  requireWebhookSecret?: boolean;
}

const VALID_IMAGE_TAG_REGEX = /^[a-zA-Z0-9._:/-]+$/;
const VALID_COMPOSE_IDENTIFIER_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function readSecret(
  filePath: string,
  envValue: string | undefined,
  stripAllWhitespace = false,
): { value: string; source: 'file' | 'env' | 'none' } {
  if (filePath && fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const cleaned = stripAllWhitespace ? raw.replace(/[\r\n\s]+/g, '') : raw.trim();
    if (cleaned.length > 0) {
      return { value: cleaned, source: 'file' };
    }
  }
  if (envValue && envValue.trim().length > 0) {
    const cleaned = stripAllWhitespace ? envValue.replace(/[\r\n\s]+/g, '') : envValue.trim();
    return { value: cleaned, source: 'env' };
  }
  return { value: '', source: 'none' };
}

function parseBoolean(value: string | undefined, defaultValue: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  throw new Error(`Invalid boolean value for ${name}: "${value}" (expected true or false)`);
}

function parseTriggerMode(value: string | undefined): TriggerMode {
  if (!value || value.trim() === '') {
    return 'poll';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'poll' || normalized === 'webhook' || normalized === 'both') {
    return normalized;
  }
  throw new Error(
    `Invalid TRIGGER_MODE "${value}". Supported values: poll, webhook, both`,
  );
}

export function normalizeWebhookPath(rawPath: string | undefined): string {
  const trimmed = (rawPath ?? '/webhook').trim();
  if (trimmed === '' || trimmed === '/') {
    return '/';
  }
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, '');
}

export function validateImageTag(imageTag: string): void {
  if (!VALID_IMAGE_TAG_REGEX.test(imageTag)) {
    throw new Error(
      `Invalid IMAGE_TAG format "${imageTag}". Only alphanumeric characters, dots, hyphens, underscores, colons, and slashes are allowed.`,
    );
  }
}

export function parseDockerBuildFlags(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return [];
  }
  const matches = trimmed.match(/(?:"[^"]*"|'[^']*'|[^\s])+/g) ?? [];
  return matches.map((token) =>
    token.replace(/"([^"]*)"|'([^']*)'/g, (_, dq?: string, sq?: string) => dq ?? sq ?? ''),
  );
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): Config {
  const gitRepo = env.GIT_REPO?.trim() ?? '';
  if (!gitRepo) {
    throw new Error('GIT_REPO environment variable is required');
  }

  const rawBranches = env.GIT_BRANCH?.trim() || 'main';
  const branchSet = new Set<string>();
  for (const part of rawBranches.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      branchSet.add(trimmed);
    }
  }
  const gitBranches = Array.from(branchSet);
  if (gitBranches.length === 0) {
    throw new Error('GIT_BRANCH must specify at least one branch');
  }

  const triggerMode = parseTriggerMode(env.TRIGGER_MODE);
  const defaultRunOnStartup = triggerMode !== 'webhook';
  const runOnStartup = parseBoolean(env.RUN_ON_STARTUP, defaultRunOnStartup, 'RUN_ON_STARTUP');

  const rawInterval = env.CHECK_INTERVAL?.trim();
  const checkIntervalMinutes = rawInterval ? Number(rawInterval) : 60;
  if (!Number.isFinite(checkIntervalMinutes) || checkIntervalMinutes <= 0) {
    throw new Error(`Invalid CHECK_INTERVAL "${env.CHECK_INTERVAL}". Must be a positive number of minutes.`);
  }

  const rawGitTimeout = env.GIT_TIMEOUT_SECONDS?.trim();
  const gitTimeoutSeconds = rawGitTimeout !== undefined && rawGitTimeout !== '' ? Number(rawGitTimeout) : 300;
  if (!Number.isFinite(gitTimeoutSeconds) || gitTimeoutSeconds < 0) {
    throw new Error(`Invalid GIT_TIMEOUT_SECONDS "${env.GIT_TIMEOUT_SECONDS}". Must be a non-negative number (0 disables timeout).`);
  }

  const rawBuildTimeout = env.BUILD_TIMEOUT_SECONDS?.trim();
  const buildTimeoutSeconds = rawBuildTimeout !== undefined && rawBuildTimeout !== '' ? Number(rawBuildTimeout) : 1800;
  if (!Number.isFinite(buildTimeoutSeconds) || buildTimeoutSeconds < 0) {
    throw new Error(`Invalid BUILD_TIMEOUT_SECONDS "${env.BUILD_TIMEOUT_SECONDS}". Must be a non-negative number (0 disables timeout).`);
  }

  const rawComposeTimeout = env.COMPOSE_TIMEOUT_SECONDS?.trim();
  const composeTimeoutSeconds =
    rawComposeTimeout !== undefined && rawComposeTimeout !== '' ? Number(rawComposeTimeout) : 300;
  if (!Number.isFinite(composeTimeoutSeconds) || composeTimeoutSeconds < 0) {
    throw new Error(
      `Invalid COMPOSE_TIMEOUT_SECONDS "${env.COMPOSE_TIMEOUT_SECONDS}". Must be a non-negative number (0 disables timeout).`,
    );
  }

  const rawPort = env.WEBHOOK_PORT?.trim();
  const webhookPort = rawPort ? Number(rawPort) : 9000;
  if (!Number.isInteger(webhookPort) || webhookPort < 1 || webhookPort > 65535) {
    throw new Error(`Invalid WEBHOOK_PORT "${env.WEBHOOK_PORT}". Must be an integer between 1 and 65535.`);
  }

  const webhookHost = env.WEBHOOK_HOST?.trim() || '0.0.0.0';
  const webhookPath = normalizeWebhookPath(env.WEBHOOK_PATH);

  const secretsDir = path.resolve(env.SECRETS_DIR?.trim() || '/app/secrets');
  const gitPatFile = env.GIT_PAT_FILE?.trim() || path.join(secretsDir, 'pat');
  const webhookSecretFile =
    env.WEBHOOK_SECRET_FILE?.trim() || path.join(secretsDir, 'webhook_secret');

  const gitPatResult = readSecret(gitPatFile, env.GIT_PAT, true);
  const webhookSecretResult = readSecret(webhookSecretFile, env.WEBHOOK_SECRET, false);

  const webhookEnabled = triggerMode === 'webhook' || triggerMode === 'both';
  const requireWebhookSecret = options.requireWebhookSecret ?? webhookEnabled;
  if (requireWebhookSecret && !webhookSecretResult.value) {
    throw new Error(
      `Webhook secret is required when TRIGGER_MODE=${triggerMode}. Mount ${webhookSecretFile} or set WEBHOOK_SECRET.`,
    );
  }

  const imageTag = env.IMAGE_TAG?.trim() || undefined;
  if (imageTag) {
    validateImageTag(imageTag);
  }

  const shouldTagEachBuild = parseBoolean(
    env.SHOULD_TAG_EACH_BUILD,
    false,
    'SHOULD_TAG_EACH_BUILD',
  );

  const dockerfilePath = env.DOCKERFILE_PATH?.trim() || '.';
  const dockerImageName = env.DOCKER_IMAGE_NAME?.trim() || 'auto-built-image';
  const dockerBuildFlags = parseDockerBuildFlags(env.DOCKER_BUILD_FLAGS);
  const buildScript = env.BUILD_SCRIPT?.trim() || undefined;
  const postBuildScript = env.POST_BUILD_SCRIPT?.trim() || undefined;

  const rawComposeDir = env.COMPOSE_PROJECT_DIR?.trim();
  const composeProjectDir = rawComposeDir ? path.resolve(rawComposeDir) : undefined;

  const composeProjectName = env.COMPOSE_PROJECT_NAME?.trim() || undefined;
  if (composeProjectName && !VALID_COMPOSE_IDENTIFIER_REGEX.test(composeProjectName)) {
    throw new Error(
      `Invalid COMPOSE_PROJECT_NAME "${composeProjectName}". Must start with an alphanumeric character and contain only alphanumeric characters, dots, hyphens, or underscores.`,
    );
  }

  const rawComposeServices = env.COMPOSE_SERVICE?.trim() ?? '';
  const composeServiceSet = new Set<string>();
  for (const part of rawComposeServices.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      if (!VALID_COMPOSE_IDENTIFIER_REGEX.test(trimmed)) {
        throw new Error(
          `Invalid COMPOSE_SERVICE entry "${trimmed}". Must start with an alphanumeric character and contain only alphanumeric characters, dots, hyphens, or underscores.`,
        );
      }
      composeServiceSet.add(trimmed);
    }
  }
  const composeServices = Array.from(composeServiceSet);

  const composeFile = env.COMPOSE_FILE?.trim() || undefined;
  if (composeFile && composeFile.startsWith('-')) {
    throw new Error(`Invalid COMPOSE_FILE "${composeFile}". Must not start with "-".`);
  }
  const composeBranch = env.COMPOSE_BRANCH?.trim() || undefined;

  const repoDir = path.resolve(env.REPO_DIR?.trim() || '/app/repo');
  const stateDir = path.resolve(env.STATE_DIR?.trim() || '/app/state');

  return {
    gitRepo,
    gitBranches,
    gitPat: gitPatResult.value,
    gitPatSource: gitPatResult.source,
    gitPatFile,
    triggerMode,
    runOnStartup,
    checkIntervalMinutes,
    gitTimeoutMs: Math.round(gitTimeoutSeconds * 1000),
    buildTimeoutMs: Math.round(buildTimeoutSeconds * 1000),
    composeTimeoutMs: Math.round(composeTimeoutSeconds * 1000),
    dockerfilePath,
    dockerImageName,
    dockerBuildFlags,
    imageTag,
    shouldTagEachBuild,
    buildScript,
    postBuildScript,
    composeProjectDir,
    composeProjectName,
    composeServices,
    composeFile,
    composeBranch,
    webhookPort,
    webhookHost,
    webhookPath,
    webhookSecret: webhookSecretResult.value,
    webhookSecretSource: webhookSecretResult.source,
    webhookSecretFile,
    repoDir,
    stateDir,
    secretsDir,
  };
}
