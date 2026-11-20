import { checkAndBuildBranch } from './builder.js';
import { loadConfig, type Config } from './config.js';
import { logger } from './logger.js';
import { BuildQueue } from './queue.js';
import { startWebhookServer, type WebhookServer } from './webhook.js';

interface CliArgs {
  once: boolean;
  branchesOverride?: string[];
  showHelp: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    once: false,
    showHelp: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once') {
      result.once = true;
    } else if (arg === '--help' || arg === '-h') {
      result.showHelp = true;
    } else if (arg === '--branch') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('--branch requires a comma-separated branch list');
      }
      i += 1;
      result.branchesOverride = value
        .split(',')
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`syno-builder — Auto Git puller, GitHub webhook listener, and Docker builder

Usage:
  syno-builder                    Run in daemon mode (configured by TRIGGER_MODE)
  syno-builder --once             Run a single check/build pass and exit
  syno-builder --once --branch main,develop
  syno-builder --help             Show this help message
`);
}

function logStartupSummary(config: Config): void {
  logger.info('=========================================================');
  logger.info('Starting Syno-Builder');
  logger.info('=========================================================');
  logger.info(`  Trigger Mode:      ${config.triggerMode}`);
  logger.info(`  Git Repository:    ${config.gitRepo}`);
  logger.info(`  Git Branch(es):    ${config.gitBranches.join(', ')}`);
  logger.info(
    `  Git PAT Auth:      ${
      config.gitPatSource === 'file'
        ? `file (${config.gitPatFile})`
        : config.gitPatSource === 'env'
          ? 'environment variable'
          : 'none (public repository)'
    }`,
  );
  logger.info(`  Dockerfile Path:   ${config.dockerfilePath}`);
  logger.info(`  Docker Image Name: ${config.dockerImageName}`);
  logger.info(`  Tag Each Build:    ${config.shouldTagEachBuild}`);
  if (config.imageTag) {
    logger.info(`  Custom Image Tag:  ${config.imageTag}`);
  }
  if (config.buildScript) {
    logger.info(`  Build Script:      ${config.buildScript}`);
  }
  if (config.postBuildScript) {
    logger.info(`  Post-Build Script: ${config.postBuildScript}`);
  }
  if (config.triggerMode === 'poll' || config.triggerMode === 'both') {
    logger.info(`  Poll Interval:     ${config.checkIntervalMinutes} minute(s)`);
  }
  if (config.triggerMode === 'webhook' || config.triggerMode === 'both') {
    logger.info(
      `  Webhook Endpoint:  http://${config.webhookHost}:${config.webhookPort}${config.webhookPath}`,
    );
    logger.info(
      `  Webhook Secret:    ${
        config.webhookSecretSource === 'file'
          ? `file (${config.webhookSecretFile})`
          : 'environment variable'
      }`,
    );
  }
  logger.info(`  Run On Startup:    ${config.runOnStartup}`);
  logger.info(
    `  Timeouts:          git=${config.gitTimeoutMs > 0 ? `${Math.round(config.gitTimeoutMs / 1000)}s` : 'disabled'}, build=${config.buildTimeoutMs > 0 ? `${Math.round(config.buildTimeoutMs / 1000)}s` : 'disabled'}`,
  );
  logger.info('=========================================================');
}

async function runOnce(config: Config, branches: string[]): Promise<number> {
  logger.info(`Running one-shot check for branch(es): ${branches.join(', ')}`);
  const controller = new AbortController();
  const onSignal = (signal: string): void => {
    logger.warn(`Received ${signal} during one-shot run. Cancelling active command...`);
    controller.abort();
  };
  const onSigTerm = (): void => onSignal('SIGTERM');
  const onSigInt = (): void => onSignal('SIGINT');
  process.once('SIGTERM', onSigTerm);
  process.once('SIGINT', onSigInt);

  let anyFailed = false;
  let anyBuilt = false;
  let aborted = false;

  try {
    for (const branch of branches) {
      if (controller.signal.aborted) {
        aborted = true;
        break;
      }
      const outcome = await checkAndBuildBranch(config, branch, controller.signal);
      if (outcome === 'failed') {
        anyFailed = true;
      } else if (outcome === 'built') {
        anyBuilt = true;
      } else if (outcome === 'aborted') {
        aborted = true;
        break;
      }
    }
  } finally {
    process.off('SIGTERM', onSigTerm);
    process.off('SIGINT', onSigInt);
  }

  if (aborted) {
    logger.warn('One-shot check aborted.');
    return 130;
  }
  if (anyFailed) {
    logger.error('One-shot check completed with errors.');
    return 1;
  }
  if (!anyBuilt) {
    logger.info('No changes detected on any branch.');
  } else {
    logger.info('One-shot build completed successfully.');
  }
  return 0;
}

async function main(): Promise<void> {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  if (cliArgs.showHelp) {
    printHelp();
    return;
  }

  const config = loadConfig(process.env, {
    requireWebhookSecret: !cliArgs.once ? undefined : false,
  });

  if (cliArgs.once) {
    const branches = cliArgs.branchesOverride ?? config.gitBranches;
    const exitCode = await runOnce(config, branches);
    process.exitCode = exitCode;
    return;
  }

  logStartupSummary(config);

  const shutdownController = new AbortController();

  const queue = new BuildQueue(async (branch, reason) => {
    logger.info(`Starting queued check for branch "${branch}" (trigger: ${reason})`);
    await checkAndBuildBranch(config, branch, shutdownController.signal);
  });

  let webhookServer: WebhookServer | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  if (config.triggerMode === 'webhook' || config.triggerMode === 'both') {
    webhookServer = await startWebhookServer({
      config,
      onPush(branch) {
        const res = queue.enqueue([branch], 'webhook');
        if (res.coalesced.length > 0) {
          logger.info(
            `Coalesced push trigger for branch "${branch}" (already queued for next pass)`,
          );
        }
      },
    });
    logger.info(
      `Webhook server listening on http://${webhookServer.host}:${webhookServer.port}${webhookServer.path} (health: /health)`,
    );
  }

  if (config.triggerMode === 'poll' || config.triggerMode === 'both') {
    const intervalMs = Math.round(config.checkIntervalMinutes * 60_000);
    pollTimer = setInterval(() => {
      logger.info(`Scheduled poll triggered (${config.checkIntervalMinutes}m interval)`);
      queue.enqueue(config.gitBranches, 'poll');
    }, intervalMs);
    logger.info(`Polling scheduler started (every ${config.checkIntervalMinutes} minute(s))`);
  }

  if (config.runOnStartup) {
    logger.info('Queueing initial startup check...');
    queue.enqueue(config.gitBranches, 'startup');
  } else {
    logger.info('Skipping initial startup check (RUN_ON_STARTUP=false). Waiting for events...');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal}. Shutting down gracefully...`);

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    if (webhookServer) {
      try {
        await webhookServer.close();
        logger.info('Webhook server stopped.');
      } catch (err) {
        logger.error(
          `Error closing webhook server: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    queue.stop();
    if (queue.isRunning()) {
      logger.info(
        `Cancelling in-flight operation on branch "${queue.getActiveBranch() ?? 'unknown'}" and waiting for cleanup...`,
      );
      shutdownController.abort();
      await queue.waitForIdle();
    }

    logger.info('Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((err: unknown) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
