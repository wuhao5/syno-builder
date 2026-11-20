# Implementation Summary

## Core Components

**Dockerfile (Multi-Stage)**
- Builder stage (`node:22-alpine`): compiles TypeScript into a single zero-dependency ESM bundle (`dist/index.mjs`) via `esbuild`
- Runtime stage (`alpine:latest`): minimal image with `nodejs` (no `npm`), `git`, `docker-cli`, `docker-cli-buildx`, `bash`, and `curl`

**TypeScript Application (`src/`)**
- `index.ts`: Daemon entrypoint (`poll`, `webhook`, `both`) and one-shot CLI (`--once`)
- `webhook.ts`: Built-in `node:http` GitHub webhook listener with HMAC-SHA256 signature verification and `/health` endpoint
- `queue.ts`: Single-flight build queue with branch coalescing for rapid pushes
- `git.ts`, `builder.ts`, `state.ts`, `config.ts`: Git sync, commit hash state tracking, Docker Buildx / custom script execution, and detached post-build hooks

**Compatibility Shim**
- `scripts/check-and-build.sh`: Forwards `docker exec syno-builder /app/check-and-build.sh` to `node /app/index.mjs --once`

## Key Configuration

- **Required**: `GIT_REPO`
- **Triggering**: `TRIGGER_MODE` (`poll` | `webhook` | `both`), `CHECK_INTERVAL`, `RUN_ON_STARTUP`
- **Webhook**: `WEBHOOK_PORT`, `WEBHOOK_PATH`, `WEBHOOK_SECRET_FILE` (`/app/secrets/webhook_secret`) or `WEBHOOK_SECRET`
- **Git & Docker**: `GIT_BRANCH`, `GIT_PAT_FILE` (`/app/secrets/pat`) or `GIT_PAT`, `DOCKERFILE_PATH`, `DOCKER_IMAGE_NAME`, `IMAGE_TAG`, `SHOULD_TAG_EACH_BUILD`, `BUILD_SCRIPT`, `POST_BUILD_SCRIPT`

## Testing & Verification

- `npm run typecheck`: Strict TypeScript validation
- `npm test`: Unit and local git integration tests using Node's built-in `node:test` runner
- `npm run build`: Single-file production bundle verification
