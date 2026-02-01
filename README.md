# Syno-Builder

The auto git puller and docker builder for Synology NAS - automatically monitors a git repository for changes and builds Docker images when changes are detected.

## Features

- 🔄 Automatically monitors git repositories for changes
- 🐳 Builds Docker images using Docker-in-Docker when changes are detected
- ⏰ Configurable check interval (default: every 1 hour)
- 🔐 Supports both public and private repositories with authentication
- 📦 Minimal Alpine Linux base image for efficiency
- 🏷️ Automatic image tagging with timestamps and branch names
- 🌿 Multiple branch support - monitor and build multiple branches simultaneously
- 🔒 Secure credential management via mounted files or environment variables

## Quick Start

### 1. Pull the Image from GitHub Container Registry

```bash
docker pull ghcr.io/wuhao5/syno-builder:latest
```

Or build locally:

```bash
docker build -t syno-builder .
```

### 2. Prepare Authentication (for private repositories)

Create a file with your Personal Access Token:

```bash
echo "ghp_your_token_here" > /path/to/pat
chmod 600 /path/to/pat
```

### 3. Run on Synology NAS

**With mounted PAT file (recommended):**

```bash
docker run -d \
  --name syno-builder \
  -e GIT_REPO=https://github.com/user/repo.git \
  -e GIT_BRANCH=main \
  -v /path/to/pat:/app/secrets/pat:ro \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v syno-builder-state:/app/state \
  --restart unless-stopped \
  ghcr.io/wuhao5/syno-builder:latest
```

**With environment variable:**

```bash
docker run -d \
  --name syno-builder \
  --env-file .env \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v syno-builder-state:/app/state \
  --restart unless-stopped \
  ghcr.io/wuhao5/syno-builder:latest
```

**Important**: The `-v /var/run/docker.sock:/var/run/docker.sock` mount is required for Docker-in-Docker functionality.

## Configuration

All configuration is done through environment variables:

### Required

- `GIT_REPO` - The git repository URL to monitor (e.g., `https://github.com/username/repo.git`)

### Optional

- `GIT_BRANCH` - The branch(es) to monitor (default: `main`)
  - Single branch: `GIT_BRANCH=main`
  - Multiple branches: `GIT_BRANCH=main,develop,staging` (comma-separated)
- `GIT_PAT_FILE` - Path to mounted file containing Personal Access Token (default: `/app/secrets/pat`)
- `GIT_PAT` - Personal Access Token as environment variable (fallback if file doesn't exist)
- `CHECK_INTERVAL` - How often to check for changes in minutes (default: `60`)
  - For best results, use intervals that divide evenly into 60 (e.g., 1, 5, 10, 15, 30, 60)
  - For intervals > 60 minutes, use multiples of 60 (e.g., 120, 180, 240 for 2, 3, 4 hours)
- `DOCKERFILE_PATH` - Path to the Dockerfile within the repository (default: `.`)
- `DOCKER_IMAGE_NAME` - Name for the built Docker image (default: `auto-built-image`)
- `IMAGE_TAG` - Docker image tag (optional)
  - If not provided, defaults to: `{DOCKER_IMAGE_NAME}:{branch}-{git-hash-7chars}`
  - Example default: `auto-built-image:main-abc1234`
  - If provided, uses the custom tag: `IMAGE_TAG=myapp:custom-tag`
- `BUILD_SCRIPT` - Path to a custom build script that replaces the default docker build command (optional)
  - Use this to customize the build process, use alternative build tools (like buildx, Podman), or add custom logic
  - The script receives all necessary environment variables: `BUILD_CONTEXT`, `DOCKERFILE_FULL_PATH`, `IMAGE_TAG`, `IMAGE_BRANCH`, `IMAGE_LATEST`, `BRANCH`, `BRANCH_SAFE`, `DOCKER_IMAGE_NAME`, `GIT_COMMIT_HASH`, `GIT_COMMIT_SHORT`, `GIT_BRANCH_NAME`, `GIT_REPO_URL`, `BUILD_TIMESTAMP`, `REPO_DIR`
  - The script should exit with status 0 on success, non-zero on failure
  - Example: `/app/scripts/custom-build.sh`
  - See `scripts/build.sh.example` for examples
- `POST_BUILD_SCRIPT` - Path to a script to run after successful build (optional)
  - The script runs in detached mode, so long-running processes like `docker compose up -d` won't block
  - Available environment variables in the script: `IMAGE_TAG`, `IMAGE_BRANCH`, `IMAGE_LATEST`, `BRANCH`, `DOCKER_IMAGE_NAME`, `REPO_DIR`
  - Example: `/app/scripts/post-build.sh`
  - See `scripts/post-build.sh.example` for examples

### Docker Build Environment Variables

The following environment variables are automatically passed to the docker build process as build arguments:
- `GIT_COMMIT_HASH` - Full commit hash of the current build
- `GIT_COMMIT_SHORT` - Short commit hash (first 7 characters)
- `GIT_BRANCH` - Branch name being built
- `GIT_REPO` - Git repository URL
- `BUILD_TIMESTAMP` - Timestamp of the build (YYYYMMDD-HHMMSS format)

To use these in your Dockerfile:
```dockerfile
ARG GIT_COMMIT_HASH
ARG GIT_BRANCH
ARG BUILD_TIMESTAMP
ENV GIT_COMMIT=${GIT_COMMIT_HASH}
ENV GIT_BRANCH=${GIT_BRANCH}
LABEL build.timestamp=${BUILD_TIMESTAMP}
```

### Docker Build Secrets

Docker build secrets are automatically available if you mount secret files to `/app/secrets` directory.
- Each file in `/app/secrets` (except `pat`) will be passed to docker build using BuildKit's `--secret` flag
- The `pat` file is reserved for git authentication and will not be included as a build secret
- If the directory doesn't exist or is empty, no secrets will be available during the build
- Mount your secrets with: `-v /path/to/local/secrets:/app/secrets:ro`

Example usage in Dockerfile with BuildKit secrets:
```dockerfile
# Access secrets during build - secrets are NOT persisted in image layers when used this way
# Each file in /app/secrets (except 'pat') is passed as --secret id=<filename>,src=<filepath>
RUN --mount=type=secret,id=api-key,target=/run/secrets/api-key \
    export API_KEY=$(cat /run/secrets/api-key) && \
    # Use API_KEY for configuration without persisting it
    echo "API key loaded for build"

# WARNING: Copying secrets to the image will persist them in layers (not recommended)
# RUN --mount=type=secret,id=api-key,target=/run/secrets/api-key \
#     cp /run/secrets/api-key /app/config/api-key.txt
```

**Example**: If you have `/path/to/secrets/database.conf` and `/path/to/secrets/api.key`, and optionally `/path/to/secrets/pat` for git auth, mount them with:
```bash
-v /path/to/secrets:/app/secrets:ro
```

The PAT file will be used for git authentication, and the other files will be passed as build secrets:
- `--secret id=database.conf,src=/app/secrets/database.conf`
- `--secret id=api.key,src=/app/secrets/api.key`
- (PAT file is excluded from build secrets)

**Docker Compose example**:
```yaml
volumes:
  - /path/to/secrets:/app/secrets:ro  # Contains pat, database.conf, api.key, etc.
```

### Example Configuration

**Single branch:**
```env
GIT_REPO=https://github.com/myuser/myapp.git
GIT_BRANCH=develop
CHECK_INTERVAL=30
DOCKERFILE_PATH=docker
DOCKER_IMAGE_NAME=myapp
```

**Multiple branches:**
```env
GIT_REPO=https://github.com/myuser/myapp.git
GIT_BRANCH=main,develop,staging
CHECK_INTERVAL=60
DOCKER_IMAGE_NAME=myapp
```

## Authentication for Private Repositories

### Recommended: File-based Authentication

1. Create a file containing your Personal Access Token:
   ```bash
   echo "your_token_here" > /path/to/pat
   chmod 600 /path/to/pat
   ```

2. Mount the file when running the container:
   ```bash
   -v /path/to/pat:/app/secrets/pat:ro
   ```

### Alternative: Environment Variable

Set the token in the `GIT_PAT` environment variable (less secure, not recommended for production).

### GitHub Personal Access Token (PAT)

1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Generate a new token with `repo` scope
3. Set the token in the `GIT_PAT` environment variable

### Other Git Providers

This solution supports any git provider (GitHub, GitLab, Bitbucket, self-hosted, etc.). The authentication mechanism automatically detects the hostname from your `GIT_REPO` URL and configures credentials accordingly.

For GitLab, Bitbucket, or other providers:
- Use their respective Personal Access Tokens or App Passwords
- Set the token in the `GIT_PAT` environment variable
- The system will automatically configure credentials for the correct hostname

The token will be automatically used for authentication when cloning and pulling from the repository.

**Security Note**: 
- Never commit your `.env` file with real credentials to version control
- The PAT is stored securely in the container using git credential helper
- Ensure your `.env` file has restricted permissions: `chmod 600 .env`
- On Synology NAS, consider using Docker Compose secrets or environment variables in the Docker UI instead of a `.env` file for production use

## How It Works

1. **Initial Run**: On startup, the container immediately checks the repository and builds if a Dockerfile is found
2. **Change Detection**: The container tracks the latest commit hash per branch in `/app/state/last_commit_<branch>.txt`
3. **Periodic Checks**: A cron job runs at the specified interval to check for new commits on all configured branches
4. **Automatic Build**: When changes are detected on any branch, Docker builds the image from that branch
5. **Tagging**: 
   - By default, each branch build is tagged with branch name and git commit hash (e.g., `myapp:main-abc1234`)
   - Each branch gets a persistent tag (e.g., `myapp:main`, `myapp:develop`)
   - Main/master branch also tagged as `latest`
   - Custom tags can be provided via the `IMAGE_TAG` environment variable

## Volume Mounts

- `/var/run/docker.sock` - Required for Docker-in-Docker
- `/app/state` - Recommended for persisting commit tracking across container restarts
- `/app/secrets/pat` - Optional mounted file containing Personal Access Token

## Monitoring

View the logs to monitor the build process:

```bash
# View live logs
docker logs -f syno-builder

# View cron job logs
docker exec syno-builder tail -f /var/log/cron.log
```

## Example: Complete Setup

```bash
# 1. Create a directory for the project
mkdir ~/syno-builder
cd ~/syno-builder

# 2. Create .env file
cat > .env << EOF
GIT_REPO=https://github.com/username/myproject.git
GIT_BRANCH=main
GIT_PAT=ghp_yourtoken
CHECK_INTERVAL=60
DOCKER_IMAGE_NAME=myproject
EOF

# 3. Build syno-builder
docker build -t syno-builder .

# 4. Run syno-builder
docker run -d \
  --name syno-builder \
  --env-file .env \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v syno-builder-state:/app/state \
  --restart unless-stopped \
  syno-builder
```

## Troubleshooting

### Container stops immediately
- Check that `GIT_REPO` is set correctly
- Verify credentials if using a private repository

### Docker build fails
- Ensure the repository contains a valid Dockerfile at the specified path
- Check Docker socket is mounted: `/var/run/docker.sock:/var/run/docker.sock`
- Verify you have permissions to access the Docker socket on Synology

### Changes not detected
- Check the cron logs: `docker exec syno-builder tail -f /var/log/cron.log`
- Verify the `CHECK_INTERVAL` is set correctly
- Ensure the container has network access to fetch from git

## Advanced Usage

### Running Manual Build Check

```bash
docker exec syno-builder /app/check-and-build.sh
```

### Changing Check Interval Without Restart

Not supported - you must restart the container with a new `CHECK_INTERVAL` value.

### Multiple Repositories

Run multiple syno-builder containers, one for each repository:

```bash
docker run -d --name syno-builder-repo1 --env-file .env.repo1 -v /var/run/docker.sock:/var/run/docker.sock syno-builder
docker run -d --name syno-builder-repo2 --env-file .env.repo2 -v /var/run/docker.sock:/var/run/docker.sock syno-builder
```

### Custom Build Script

You can replace the default `docker build` command with a custom build script by setting the `BUILD_SCRIPT` environment variable. This is useful for:
- Using alternative build tools (e.g., docker buildx for multi-platform builds, Podman)
- Adding custom pre-build or post-build processing
- Implementing custom build logic or optimization
- Using additional build arguments or flags

```bash
# Create your custom build script
cat > /path/to/custom-build.sh << 'EOF'
#!/bin/bash
set -e

echo "Custom build: Building Docker image"
echo "Image tag: $IMAGE_TAG"

# Example: Using docker buildx for multi-platform builds
docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --build-arg GIT_COMMIT_HASH="$GIT_COMMIT_HASH" \
    --build-arg GIT_BRANCH="$GIT_BRANCH_NAME" \
    -t "$IMAGE_TAG" \
    -t "$IMAGE_BRANCH" \
    "$BUILD_CONTEXT"

# Tag as latest for main/master branch
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
    docker tag "$IMAGE_TAG" "$IMAGE_LATEST"
fi

echo "Custom build completed"
EOF

chmod +x /path/to/custom-build.sh

# Mount and configure the script
docker run -d \
  --name syno-builder \
  -e GIT_REPO=https://github.com/user/repo.git \
  -e BUILD_SCRIPT=/app/custom/custom-build.sh \
  -v /path/to/custom-build.sh:/app/custom/custom-build.sh:ro \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v syno-builder-state:/app/state \
  --restart unless-stopped \
  ghcr.io/wuhao5/syno-builder:latest
```

See `scripts/build.sh.example` for more examples of custom build scripts.

**Important Notes:**
- Custom build scripts are responsible for their own image tagging, including the `latest` tag for main/master branches
- The script should exit with status code 0 on success, non-zero on failure
- Make sure your custom build script is executable (`chmod +x`) before mounting it

**Available environment variables in custom build script:**
- `BUILD_CONTEXT` - Path to the build context directory
- `DOCKERFILE_FULL_PATH` - Full path to the Dockerfile
- `IMAGE_TAG` - Image tag with git commit hash (e.g., `myapp:main-abc1234`) or custom tag if provided via IMAGE_TAG environment variable
- `IMAGE_BRANCH` - Branch image tag (e.g., `myapp:main`)
- `IMAGE_LATEST` - Latest tag (only for main/master branch)
- `BRANCH` - Git branch name
- `BRANCH_SAFE` - Git branch with slashes replaced by dashes
- `DOCKER_IMAGE_NAME` - Base image name
- `GIT_COMMIT_HASH` - Full git commit hash
- `GIT_COMMIT_SHORT` - Short git commit hash (7 chars)
- `GIT_BRANCH_NAME` - Git branch name
- `GIT_REPO_URL` - Git repository URL
- `BUILD_TIMESTAMP` - Build timestamp (YYYYMMDD-HHMMSS)
- `REPO_DIR` - Path to the cloned repository

### Post-Build Script

You can run custom scripts after a successful build by setting the `POST_BUILD_SCRIPT` environment variable:

```bash
# Create your post-build script
cat > /path/to/post-build.sh << 'EOF'
#!/bin/bash
echo "Deploying $IMAGE_TAG"
docker stop my-app || true
docker rm my-app || true
docker run -d --name my-app "$IMAGE_TAG"
EOF

chmod +x /path/to/post-build.sh

# Mount and configure the script
docker run -d \
  --name syno-builder \
  -e GIT_REPO=https://github.com/user/repo.git \
  -e POST_BUILD_SCRIPT=/app/custom/post-build.sh \
  -v /path/to/post-build.sh:/app/custom/post-build.sh:ro \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v syno-builder-state:/app/state \
  --restart unless-stopped \
  ghcr.io/wuhao5/syno-builder:latest
```

The post-build script runs in detached mode, so long-running commands like `docker compose up -d` won't block the build process. See `scripts/post-build.sh.example` for more examples.

### Docker Image Cleanup

When Docker builds images, it creates intermediate layers (cached as `<none>:<none>` images). These layers are **useful for speeding up future builds** through layer caching. However, on storage-limited systems like Synology NAS, you may want to periodically clean up unused images.

**Recommendation**: Keep build cache for performance, but run cleanup periodically if storage is a concern.

```bash
# Remove dangling images only (safe, keeps layer cache)
docker exec syno-builder docker image prune -f

# Remove all unused images (more aggressive, may slow down future builds)
docker exec syno-builder docker image prune -a -f

# Full system cleanup (removes unused containers, networks, images, build cache)
docker exec syno-builder docker system prune -f
```

You can also add cleanup to your post-build script to automatically clean up after each build:

```bash
# Add to your post-build script
docker image prune -f
```

**Note**: The trade-off is between storage space and build speed. Removing cached layers means Docker will need to rebuild those layers from scratch on the next build.

## License

MIT
