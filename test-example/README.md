# Test Example

This directory contains a simple test setup to demonstrate the syno-builder functionality.

## Setup

1. Create a test repository with a Dockerfile (or use an existing one)
2. Copy `.env.example` to `.env` and configure it
3. Run the syno-builder

## Test Scenario

The `test-repo-example` directory simulates a git repository with a simple Dockerfile that would be built.

## Manual Testing

```bash
# Build the syno-builder image
docker build -t syno-builder .

# Create test .env file
cat > .env << EOF
GIT_REPO=https://github.com/docker-library/hello-world.git
GIT_BRANCH=master
CHECK_INTERVAL=5
DOCKER_IMAGE_NAME=test-hello-world
EOF

# Run syno-builder
docker run -d \
  --name syno-builder-test \
  --env-file .env \
  -v /var/run/docker.sock:/var/run/docker.sock \
  syno-builder

# Check logs
docker logs -f syno-builder-test
```

Expected behavior:
1. Container starts and clones the repository
2. Detects the Dockerfile
3. Builds the Docker image
4. Tags it as `test-hello-world:latest` and with timestamp
5. Sets up cron to check every 5 minutes
