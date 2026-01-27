# Implementation Summary

## Core Components

**Dockerfile**
- Alpine Linux-based minimal image with git, docker-cli, bash, dcron
- Configurable environment variables for repository, branch, credentials, and build settings

**Scripts**
- `entrypoint.sh`: Initializes cron scheduler and runs initial check
- `check-and-build.sh`: Monitors git repository, detects changes via commit hash, triggers Docker builds

**Change Detection**
- Tracks last processed commit hash in `/app/state/last_commit.txt`
- Builds only when new commits are detected
- Persistent state across container restarts

## Configuration

**Required**
- `GIT_REPO`: Repository URL
- `GIT_PAT_FILE`: Path to mounted file containing Personal Access Token (fallback to `GIT_PAT` env var)

**Optional**
- `GIT_BRANCH`: Branch to monitor (default: main) - supports comma-separated list for multiple branches
- `CHECK_INTERVAL`: Polling frequency in minutes (default: 60)
- `DOCKERFILE_PATH`: Path to Dockerfile within repository (default: .)
- `DOCKER_IMAGE_NAME`: Output image name (default: auto-built-image)

## Security

- Credentials read from mounted file or environment variable
- Stored using git credential helper with 600 permissions
- Hostname auto-detected from repository URL (supports GitHub, GitLab, Bitbucket, self-hosted)
- No credential exposure in logs

## Deployment

```bash
docker run -d \
  -e GIT_REPO=https://github.com/user/repo.git \
  -v /path/to/pat:/app/secrets/pat:ro \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v syno-builder-state:/app/state \
  syno-builder
```

Built images are tagged with `${DOCKER_IMAGE_NAME}:YYYYMMDD-HHMMSS` and `:latest`.

## Files

- `Dockerfile`, `docker-compose.yml` - Container definition
- `scripts/entrypoint.sh`, `scripts/check-and-build.sh` - Core automation logic
- `.env.example` - Configuration template
- `README.md` - User documentation
