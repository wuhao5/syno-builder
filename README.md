# Syno-Builder

The auto git puller, GitHub webhook listener, and Docker image builder for Synology NAS — automatically monitors a git repository (via GitHub push webhooks, periodic polling, or both) and builds Docker images when new commits arrive.

## Features

- ⚡ **Push Mode (GitHub Webhooks)**: Trigger builds instantly on `git push` with HMAC-SHA256 signature verification
- 🔄 **Polling & Hybrid Modes**: Supports `poll`, `webhook`, or `both` (instant webhooks + periodic fallback check)
- 🧱 **Build Queue & Coalescing**: Serializes Docker builds safely and merges rapid pushes into a single follow-up build
- 🐳 **Docker Buildx Support**: Builds Docker images using Docker-in-Docker (`docker buildx build`)
- 🔐 **Secure Credential Handling**: File-mounted PAT & webhook secret, scoped environment-based git auth (no plaintext credentials written to disk)
- 📦 **Slim Alpine + Node.js Runtime**: Multi-stage TypeScript build with zero runtime npm dependencies
- 🌿 **Multiple Branch Support**: Monitor and build multiple branches simultaneously (including slash-containing names like `feature/login`)
- 🪝 **Custom Hooks**: Supports custom `BUILD_SCRIPT` and detached `POST_BUILD_SCRIPT`

## Quick Start

### 1. Pull the Image from GitHub Container Registry

```bash
docker pull ghcr.io/wuhao5/syno-builder:latest
```

Or build locally:

```bash
docker build -t syno-builder .
```

### 2. Prepare Secrets

Create a secrets directory on your Synology NAS:

```bash
mkdir -p /path/to/secrets
# Optional: GitHub Personal Access Token (for private repositories)
echo "ghp_your_token_here" > /path/to/secrets/pat
# Required when using TRIGGER_MODE=webhook or both:
openssl rand -hex 32 > /path/to/secrets/webhook_secret
chmod 600 /path/to/secrets/*
```

### 3. Run on Synology NAS

#### Option A: Push Mode (GitHub Webhook + Synology Reverse Proxy)

```bash
docker run -d \
  --name syno-builder \
  -p 127.0.0.1:9000:9000 \
  -e GIT_REPO=https://github.com/user/repo.git \
  -e GIT_BRANCH=main \
  -e TRIGGER_MODE=webhook \
  -e DOCKER_IMAGE_NAME=myapp \
  -v /path/to/secrets:/app/secrets:ro \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v syno-builder-state:/app/state \
  --restart unless-stopped \
  ghcr.io/wuhao5/syno-builder:latest
```

*(Tip: Use `TRIGGER_MODE=both` with `CHECK_INTERVAL=360` to get instant webhook builds plus a 6-hour fallback poll in case your NAS was offline during a push.)*

#### Option B: Polling Mode (Default)

```bash
docker run -d \
  --name syno-builder \
  -e GIT_REPO=https://github.com/user/repo.git \
  -e GIT_BRANCH=main \
  -e CHECK_INTERVAL=60 \
  -v /path/to/secrets/pat:/app/secrets/pat:ro \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v syno-builder-state:/app/state \
  --restart unless-stopped \
  ghcr.io/wuhao5/syno-builder:latest
```

**Important**: The `-v /var/run/docker.sock:/var/run/docker.sock` mount is required for Docker-in-Docker functionality.

## Setting Up Push Mode with Synology Reverse Proxy & GitHub

### 1. Bind the Webhook Port to Localhost Only

In `docker-compose.yml` or `docker run`, publish port `9000` on `127.0.0.1` (`127.0.0.1:9000:9000`) so the HTTP listener is only reachable through Synology's HTTPS Reverse Proxy.

### 2. Configure Synology DSM Reverse Proxy & SSL

1. **SSL Certificate**: Open **Control Panel → Security → Certificate** and make sure you have a Let's Encrypt certificate covering your DDNS subdomain (e.g., `myname.synology.me` with Subject Alternative Name `*.myname.synology.me`).
2. **Reverse Proxy**: Open **Control Panel → Login Portal → Advanced → Reverse Proxy → Create**:
   - **Source**: Protocol `HTTPS`, Hostname `hooks.myname.synology.me`, Port `443`
   - **Destination**: Protocol `HTTP`, Hostname `localhost`, Port `9000`
3. **Verify Routing**:
   ```bash
   curl https://hooks.myname.synology.me/health
   # Expected: {"status":"ok"}
   ```

### 3. Configure the GitHub Webhook

1. Open your GitHub repository → **Settings → Webhooks → Add webhook**.
2. Set:
   - **Payload URL**: `https://hooks.myname.synology.me/webhook`
   - **Content type**: `application/json`
   - **Secret**: The exact string stored in `/path/to/secrets/webhook_secret` (or `WEBHOOK_SECRET`)
   - **SSL verification**: **Enable SSL verification**
   - **Which events**: **Just the `push` event**
   - **Active**: Checked
3. Click **Add webhook**. GitHub immediately sends a `ping` event; confirm a green `200` (`{"status":"pong"}`) in **Recent Deliveries**.

## Configuration

All configuration is done through environment variables:

### Required

- `GIT_REPO` - The git repository URL to monitor (e.g., `https://github.com/username/repo.git`)

### Trigger & Webhook Options

- `TRIGGER_MODE` - How builds are triggered (default: `poll`)
  - `poll` - Check for new commits every `CHECK_INTERVAL` minutes
  - `webhook` - Run the HTTP webhook server and build on verified GitHub `push` events
  - `both` - Run both the webhook server and the periodic polling fallback
- `RUN_ON_STARTUP` - Run an initial check immediately on container startup
  - Defaults to `true` in `poll` and `both` modes, `false` in `webhook` mode
- `CHECK_INTERVAL` - Polling interval in minutes (default: `60`; supports any positive number)
- `WEBHOOK_PORT` - Port for the webhook HTTP server (default: `9000`)
- `WEBHOOK_HOST` - Bind address inside the container (default: `0.0.0.0`)
- `WEBHOOK_PATH` - HTTP endpoint path for webhook deliveries (default: `/webhook`)
- `WEBHOOK_SECRET_FILE` - Mounted file containing the GitHub webhook secret (default: `/app/secrets/webhook_secret`)
- `WEBHOOK_SECRET` - Fallback environment variable for the GitHub webhook secret (required when `TRIGGER_MODE` is `webhook` or `both` if the secret file is not present)

### Repository & Build Options

- `GIT_BRANCH` - Branch(es) to monitor (default: `main`)
  - Single branch: `GIT_BRANCH=main`
  - Multiple branches: `GIT_BRANCH=main,develop,staging` (comma-separated)
- `GIT_PAT_FILE` - Path to mounted file containing Personal Access Token (default: `/app/secrets/pat`)
- `GIT_PAT` - Personal Access Token as environment variable (fallback if file doesn't exist)
- `DOCKERFILE_PATH` - Path to the Dockerfile directory within the repository (default: `.`)
- `DOCKER_IMAGE_NAME` - Name for the built Docker image (default: `auto-built-image`)
- `IMAGE_TAG` - Custom Docker image tag (optional)
  - If not provided and `SHOULD_TAG_EACH_BUILD=true`, defaults to `{DOCKER_IMAGE_NAME}:{branch}-{git-hash-7chars}`
- `SHOULD_TAG_EACH_BUILD` - Enable unique commit-based tag per build (default: `false`)
  - When `false`: Only tags with `IMAGE_BRANCH` (e.g., `myapp:main`)
  - When `true`: Also tags with `IMAGE_TAG` (e.g., `myapp:main-abc1234`)
- `BUILD_SCRIPT` - Path to a custom build script replacing `docker buildx build` (optional; see `scripts/build.sh.example`)
- `POST_BUILD_SCRIPT` - Path to a script run detached after a successful build (optional; see `scripts/post-build.sh.example`)
- `GIT_TIMEOUT_SECONDS` - Timeout per git command in seconds (default: `300`; set `0` to disable)
- `BUILD_TIMEOUT_SECONDS` - Timeout per Docker build / `BUILD_SCRIPT` in seconds (default: `1800`; set `0` to disable)

### Docker Build Environment Variables

Passed automatically as `--build-arg` to `docker buildx build`:
- `GIT_COMMIT_HASH` - Full commit hash
- `GIT_COMMIT_SHORT` - Short commit hash (7 chars)
- `GIT_BRANCH` - Branch name
- `GIT_REPO` - Git repository URL
- `BUILD_TIMESTAMP` - Build timestamp (`YYYYMMDD-HHMMSS`)

### Docker Build Secrets

Mount secret files to `/app/secrets` (`-v /path/to/local/secrets:/app/secrets:ro`):
- Every regular non-hidden file in `/app/secrets` — **except** `pat`, `webhook_secret`, and any custom `GIT_PAT_FILE` / `WEBHOOK_SECRET_FILE` paths — is automatically passed to `docker buildx build` as `--secret id=<filename>,src=<filepath>`.

```dockerfile
RUN --mount=type=secret,id=api-key,target=/run/secrets/api-key \
    export API_KEY=$(cat /run/secrets/api-key) && \
    echo "API key loaded for build"
```

## How It Works

1. **Triggering**:
   - In `webhook` / `both` mode, the built-in Node.js HTTP server validates `X-Hub-Signature-256` (constant-time HMAC-SHA256), checks the repository URL and tracked branch, responds `202 Accepted` immediately, and enqueues the branch.
   - In `poll` / `both` mode, an in-process timer enqueues all configured branches every `CHECK_INTERVAL` minutes.
2. **Single-Flight Queue & Coalescing**: Only one git sync / Docker build runs at a time. Rapid pushes to the same branch during an active build are coalesced into a single follow-up build on the newest commit.
3. **Change Detection**: Compares `HEAD` against `/app/state/last_commit_<branch>.txt`. Builds only run when the commit hash changes.
4. **Build & Tagging**: Runs `docker buildx build` (or `BUILD_SCRIPT`), tags `:branch` (plus `:branch-<sha7>` when `SHOULD_TAG_EACH_BUILD=true`, and `:latest` for `main`/`master`), runs `POST_BUILD_SCRIPT` detached if configured, and persists the new commit hash.

## Monitoring & Manual Runs

```bash
# View live container logs
docker logs -f syno-builder

# Trigger a manual one-shot check across configured branches
docker exec syno-builder /app/check-and-build.sh
# Or directly via Node:
docker exec syno-builder node /app/index.mjs --once
docker exec syno-builder node /app/index.mjs --once --branch main
```

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## License

MIT
