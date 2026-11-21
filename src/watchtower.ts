import type { Config } from './config.js';
import { logger } from './logger.js';

export interface WatchtowerTarget {
  image?: string;
  container?: string;
}

export interface WatchtowerResult {
  ok: boolean;
  statusCode: number;
  bodyText: string;
  summary?: {
    scanned?: number;
    updated?: number;
    failed?: number;
  };
  error?: string;
}

export function buildWatchtowerUpdateUrl(
  baseUrl: string,
  target: WatchtowerTarget = {},
): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const url = new URL(`${normalizedBase}/v1/update`);

  if (target.image?.trim()) {
    url.searchParams.set('image', target.image.trim());
  }
  if (target.container?.trim()) {
    url.searchParams.set('container', target.container.trim());
  }

  return url.toString();
}

/**
 * Extracts a container image reference (e.g. "ghcr.io/owner/repo:tag") from a
 * GitHub `package` or `registry_package` webhook payload.
 */
export function extractPackageImageRef(payload: Record<string, unknown>): string | null {
  const pkg =
    (payload.package as Record<string, unknown> | undefined) ??
    (payload.registry_package as Record<string, unknown> | undefined);
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return null;
  }

  const packageType =
    typeof pkg.package_type === 'string' ? pkg.package_type.toLowerCase() : '';
  if (packageType && packageType !== 'container' && packageType !== 'docker') {
    return null;
  }

  const pkgVersion = pkg.package_version as Record<string, unknown> | undefined;
  const containerMeta = pkgVersion?.container_metadata as Record<string, unknown> | undefined;
  const tagObj = containerMeta?.tag as Record<string, unknown> | undefined;
  const tagName = typeof tagObj?.name === 'string' ? tagObj.name.trim() : '';

  const rawPackageUrl =
    typeof pkgVersion?.package_url === 'string' ? pkgVersion.package_url.trim() : '';

  if (rawPackageUrl) {
    // Strip scheme if present (e.g., "oci://ghcr.io/..." or "https://...")
    const withoutScheme = rawPackageUrl.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    if (withoutScheme.includes('@sha256:')) {
      const baseRef = withoutScheme.split('@')[0];
      if (baseRef && tagName) {
        return `${baseRef}:${tagName}`;
      }
      return withoutScheme;
    }
    if (withoutScheme.includes(':')) {
      return withoutScheme;
    }
    return tagName ? `${withoutScheme}:${tagName}` : withoutScheme;
  }

  const pkgName = typeof pkg.name === 'string' ? pkg.name.trim().toLowerCase() : '';
  const namespace =
    typeof pkg.namespace === 'string'
      ? pkg.namespace.trim().toLowerCase()
      : typeof (pkg.owner as Record<string, unknown> | undefined)?.login === 'string'
        ? ((pkg.owner as Record<string, unknown>).login as string).trim().toLowerCase()
        : typeof ((payload.repository as Record<string, unknown> | undefined)?.owner as Record<string, unknown> | undefined)?.login === 'string'
          ? (((payload.repository as Record<string, unknown>).owner as Record<string, unknown>).login as string).trim().toLowerCase()
          : '';

  if (namespace && pkgName) {
    const base = `ghcr.io/${namespace}/${pkgName}`;
    return tagName ? `${base}:${tagName}` : base;
  }

  return null;
}

export async function triggerWatchtowerUpdate(
  config: Config,
  target: WatchtowerTarget = {},
  signal?: AbortSignal,
): Promise<WatchtowerResult> {
  if (!config.watchtowerUrl) {
    return {
      ok: false,
      statusCode: 0,
      bodyText: '',
      error: 'WATCHTOWER_URL is not configured',
    };
  }

  const updateUrl = buildWatchtowerUpdateUrl(config.watchtowerUrl, target);
  logger.info(`Triggering Watchtower update: POST ${updateUrl}`);

  const signals: AbortSignal[] = [];
  if (signal) {
    signals.push(signal);
  }
  if (config.watchtowerTimeoutMs > 0) {
    signals.push(AbortSignal.timeout(config.watchtowerTimeoutMs));
  }
  const combinedSignal =
    signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);

  try {
    const response = await fetch(updateUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.watchtowerToken}`,
      },
      signal: combinedSignal,
    });

    const bodyText = await response.text();
    let summary: WatchtowerResult['summary'];

    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (record.summary && typeof record.summary === 'object' && !Array.isArray(record.summary)) {
          const sum = record.summary as Record<string, unknown>;
          summary = {
            scanned: typeof sum.scanned === 'number' ? sum.scanned : undefined,
            updated: typeof sum.updated === 'number' ? sum.updated : undefined,
            failed: typeof sum.failed === 'number' ? sum.failed : undefined,
          };
        }
      }
    } catch {
      // Non-JSON response body is fine
    }

    if (!response.ok) {
      const errorMsg = `Watchtower returned HTTP ${response.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`;
      logger.error(errorMsg);
      return {
        ok: false,
        statusCode: response.status,
        bodyText,
        summary,
        error: errorMsg,
      };
    }

    if (summary) {
      logger.info(
        `Watchtower update completed (scanned=${summary.scanned ?? '?'}, updated=${summary.updated ?? '?'}, failed=${summary.failed ?? '?'})`,
      );
    } else {
      logger.info(`Watchtower update completed (HTTP ${response.status}).`);
    }

    return {
      ok: true,
      statusCode: response.status,
      bodyText,
      summary,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to trigger Watchtower update: ${message}`);
    return {
      ok: false,
      statusCode: 0,
      bodyText: '',
      error: message,
    };
  }
}
