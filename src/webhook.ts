import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from './config.js';
import { normalizeRepoUrl } from './git.js';
import { logger } from './logger.js';

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024; // 1 MB
const ZERO_SHA = '0000000000000000000000000000000000000000';
const SIGNATURE_REGEX = /^sha256=([0-9a-f]{64})$/i;

export interface PushEventMeta {
  commit?: string;
  deliveryId?: string;
}

export interface WebhookServerOptions {
  config: Config;
  onPush: (branch: string, meta: PushEventMeta) => void;
  maxBodyBytes?: number;
}

export interface WebhookServer {
  server: http.Server;
  port: number;
  host: string;
  path: string;
  close(): Promise<void>;
}

export function verifyGitHubSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!secret || !signatureHeader) {
    return false;
  }

  const match = SIGNATURE_REGEX.exec(signatureHeader.trim());
  if (!match?.[1]) {
    return false;
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(match[1], 'hex');

  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

export function parseWebhookPayload(
  rawBody: Buffer,
  contentType: string | undefined,
): Record<string, unknown> | null {
  const mimeType = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  let jsonText: string;

  if (mimeType === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(rawBody.toString('utf8'));
    const payloadParam = params.get('payload');
    if (!payloadParam) {
      return null;
    }
    jsonText = payloadParam;
  } else {
    jsonText = rawBody.toString('utf8');
  }

  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  const serialized = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(serialized),
    ...extraHeaders,
  });
  res.end(serialized);
}

function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let exceeded = false;

    req.on('data', (chunk: Buffer) => {
      if (exceeded) {
        return;
      }
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        exceeded = true;
        chunks.length = 0;
        const err = new Error('Payload too large');
        err.name = 'PayloadTooLargeError';
        reject(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!exceeded) {
        resolve(Buffer.concat(chunks));
      }
    });

    req.on('error', (err) => {
      if (!exceeded) {
        reject(err);
      }
    });
  });
}

function matchesExpectedRepo(
  payload: Record<string, unknown>,
  expectedNormalizedRepo: string | null,
): boolean {
  if (!expectedNormalizedRepo) {
    return true;
  }

  const repository = payload.repository;
  if (typeof repository !== 'object' || repository === null || Array.isArray(repository)) {
    return true;
  }

  const repoRecord = repository as Record<string, unknown>;
  const candidates = [repoRecord.clone_url, repoRecord.html_url, repoRecord.ssh_url].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );

  if (candidates.length === 0) {
    return true;
  }

  return candidates.some((url) => normalizeRepoUrl(url) === expectedNormalizedRepo);
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function createWebhookRequestListener(
  options: WebhookServerOptions,
): http.RequestListener {
  const { config, onPush, maxBodyBytes = MAX_WEBHOOK_BODY_BYTES } = options;
  const trackedBranches = new Set(config.gitBranches);
  const expectedRepo = normalizeRepoUrl(config.gitRepo);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rawUrl = req.url ?? '/';
    let pathname: string;
    try {
      pathname = new URL(rawUrl, 'http://localhost').pathname;
    } catch {
      sendJson(res, 400, { error: 'Invalid request URL' });
      return;
    }

    const normalizedPathname =
      pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

    if (normalizedPathname === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
        return;
      }
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (normalizedPathname !== config.webhookPath) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      return;
    }

    const contentLengthHeader = getHeader(req, 'content-length');
    if (contentLengthHeader) {
      const declaredLength = Number(contentLengthHeader);
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        req.resume();
        sendJson(res, 413, { error: 'Payload too large' }, { Connection: 'close' });
        return;
      }
    }

    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof Error && err.name === 'PayloadTooLargeError') {
        sendJson(res, 413, { error: 'Payload too large' }, { Connection: 'close' });
        return;
      }
      logger.error(
        `Failed to read webhook request body: ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJson(res, 400, { error: 'Failed to read request body' });
      return;
    }

    const deliveryId = getHeader(req, 'x-github-delivery');
    const event = getHeader(req, 'x-github-event')?.toLowerCase();
    const signature = getHeader(req, 'x-hub-signature-256');

    if (!verifyGitHubSignature(config.webhookSecret, rawBody, signature)) {
      logger.warn(
        `Rejected webhook request (delivery=${deliveryId ?? 'unknown'}): invalid or missing X-Hub-Signature-256`,
      );
      sendJson(res, 401, { error: 'Invalid signature' });
      return;
    }

    if (event === 'ping') {
      logger.info(`Received GitHub ping webhook (delivery=${deliveryId ?? 'unknown'})`);
      sendJson(res, 200, { status: 'pong' });
      return;
    }

    if (event !== 'push') {
      logger.info(
        `Ignoring unsupported GitHub event "${event ?? 'unknown'}" (delivery=${deliveryId ?? 'unknown'})`,
      );
      sendJson(res, 200, { status: 'ignored', reason: 'unsupported event' });
      return;
    }

    const payload = parseWebhookPayload(rawBody, getHeader(req, 'content-type'));
    if (!payload) {
      logger.warn(`Rejected malformed push payload (delivery=${deliveryId ?? 'unknown'})`);
      sendJson(res, 400, { error: 'Invalid JSON payload' });
      return;
    }

    if (!matchesExpectedRepo(payload, expectedRepo)) {
      logger.warn(
        `Ignoring push webhook for mismatched repository (delivery=${deliveryId ?? 'unknown'})`,
      );
      sendJson(res, 200, { status: 'ignored', reason: 'repository mismatch' });
      return;
    }

    const ref = typeof payload.ref === 'string' ? payload.ref : '';
    if (!ref.startsWith('refs/heads/')) {
      logger.info(
        `Ignoring non-branch ref "${ref || 'unknown'}" (delivery=${deliveryId ?? 'unknown'})`,
      );
      sendJson(res, 200, { status: 'ignored', reason: 'non-branch ref' });
      return;
    }

    const after = typeof payload.after === 'string' ? payload.after : undefined;
    if (payload.deleted === true || after === ZERO_SHA) {
      logger.info(
        `Ignoring branch deletion event for "${ref}" (delivery=${deliveryId ?? 'unknown'})`,
      );
      sendJson(res, 200, { status: 'ignored', reason: 'branch deleted' });
      return;
    }

    const branch = ref.slice('refs/heads/'.length);
    if (!trackedBranches.has(branch)) {
      logger.info(
        `Ignoring push to untracked branch "${branch}" (delivery=${deliveryId ?? 'unknown'})`,
      );
      sendJson(res, 200, { status: 'ignored', reason: 'untracked branch' });
      return;
    }

    const commitShort = after ? after.slice(0, 7) : undefined;
    logger.info(
      `Accepted push webhook for branch "${branch}"${commitShort ? ` (${commitShort})` : ''} (delivery=${deliveryId ?? 'unknown'})`,
    );

    onPush(branch, { commit: after, deliveryId });

    sendJson(res, 202, {
      status: 'queued',
      branch,
      ...(commitShort ? { commit: commitShort } : {}),
    });
  };
}

export async function startWebhookServer(
  options: WebhookServerOptions,
): Promise<WebhookServer> {
  const listener = createWebhookRequestListener(options);
  const server = http.createServer(listener);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.config.webhookPort, options.config.webhookHost);
  });

  const address = server.address() as AddressInfo;

  return {
    server,
    port: address.port,
    host: address.address,
    path: options.config.webhookPath,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
        server.closeIdleConnections?.();
      });
    },
  };
}
