# Syno-Builder Architecture

## System Architecture

```text
GitHub (push event)
   │ HTTPS POST + X-Hub-Signature-256
   ▼
Synology DSM Reverse Proxy (:443 -> 127.0.0.1:9000)
   │ HTTP POST /webhook
   ▼
┌────────────────────────────────────────────────────────────────┐
│                     Syno-Builder Container                      │
│                   (Alpine + Node.js Runtime)                    │
│                                                                 │
│  ┌────────────────────┐      ┌──────────────────────────────┐  │
│  │ Webhook Server     │      │ Polling Scheduler            │  │
│  │ (node:http, :9000) │      │ (setInterval, CHECK_INTERVAL)│  │
│  │ - HMAC-SHA256 auth │      └──────────────┬───────────────┘  │
│  │ - repo/branch match│                     │                  │
│  │ - 202 Accepted     │                     │                  │
│  └─────────┬──────────┘                     │                  │
│            └──────────────┬─────────────────┘                  │
│                           ▼                                    │
│            ┌──────────────────────────────┐                    │
│            │ BuildQueue                   │                    │
│            │ - Single-flight execution    │                    │
│            │ - Branch coalescing (Set)    │                    │
│            └──────────────┬───────────────┘                    │
│                           ▼                                    │
│            ┌──────────────────────────────┐                    │
│            │ Git Sync + State + Builder   │                    │
│            │ 1. git fetch/reset (env auth)│                    │
│            │ 2. Compare /app/state hash   │                    │
│            │ 3. docker buildx / script    │                    │
│            │ 4. Optional docker compose up│                    │
│            │ 5. Detached POST_BUILD_SCRIPT│                    │
│            └──────────────┬───────────────┘                    │
└───────────────────────────┼────────────────────────────────────┘
                            ▼
                 /var/run/docker.sock
```

## Trigger Modes

| Mode | Webhook Server | Polling Timer | Default `RUN_ON_STARTUP` |
| :--- | :--- | :--- | :--- |
| `poll` *(default)* | Off | On (`CHECK_INTERVAL`) | `true` |
| `webhook` | On (`WEBHOOK_PORT`) | Off | `false` |
| `both` | On (`WEBHOOK_PORT`) | On (`CHECK_INTERVAL`) | `true` |

## Source Modules

| File | Responsibility |
| :--- | :--- |
| `src/index.ts` | Entrypoint, CLI (`--once`, `--branch`), mode startup, graceful `SIGTERM`/`SIGINT` shutdown |
| `src/config.ts` | Environment variable & secret file loading with strict validation |
| `src/webhook.ts` | `node:http` server (`/webhook`, `/health`), constant-time HMAC-SHA256 verification, payload & repo/branch filtering |
| `src/queue.ts` | Single-flight `BuildQueue` with duplicate branch coalescing |
| `src/git.ts` | Repository cloning, explicit refspec fetch/reset, and env-scoped `GIT_CONFIG_*` PAT auth |
| `src/builder.ts` | BuildKit secret discovery (excluding `pat`/`webhook_secret`), per-branch tagging, `docker buildx build`, custom/post-build scripts |
| `src/exec.ts` | Child-process runner with POSIX process-group isolation, `AbortSignal` cancellation, and `SIGTERM` → `SIGKILL` timeout escalation |
| `src/state.ts` | Atomic commit hash persistence in `/app/state/last_commit_<branch>.txt` |
| `src/logger.ts` | Timestamped logging to stdout/stderr (`docker logs`) |

## Process Lifecycle & Security Considerations

1. **PID 1 & Zombie Reaping**: The container runs `tini` (`/sbin/tini -- node /app/index.mjs`) as PID 1 to forward signals cleanly and automatically reap completed detached `POST_BUILD_SCRIPT` processes.
2. **Process-Group Cancellation & Timeouts**: `git` and Docker build subprocesses run in their own POSIX process groups with configurable timeouts (`GIT_TIMEOUT_SECONDS`, `BUILD_TIMEOUT_SECONDS`) and `AbortSignal` propagation on `SIGTERM`/`SIGINT` (`SIGTERM` followed by `SIGKILL` after 5s grace).
3. **Webhook Verification**: Constant-time HMAC-SHA256 validation (`X-Hub-Signature-256`) is mandatory in `webhook` and `both` modes; payloads over 1 MB are rejected with `413`.
4. **Localhost Port Binding**: `docker-compose.yml` binds `127.0.0.1:9000:9000` so external traffic must pass through Synology DSM's HTTPS Reverse Proxy.
5. **Ephemeral Git Auth**: PAT tokens are passed to `git` via scoped `GIT_CONFIG_*` environment variables (`GIT_TERMINAL_PROMPT=0`) rather than written to `~/.git-credentials`.
6. **Reserved Secrets Excluded from Builds**: `pat` and `webhook_secret` in `/app/secrets` are excluded from Docker BuildKit `--secret` mounts.
