#!/bin/bash
set -e

echo "==================================="
echo "Git Change Checker and Docker Builder"
echo "==================================="

# Required environment variables validation
if [ -z "$GIT_REPO" ]; then
    echo "ERROR: GIT_REPO environment variable is required"
    exit 1
fi

# Set defaults
GIT_BRANCH="${GIT_BRANCH:-main}"
DOCKERFILE_PATH="${DOCKERFILE_PATH:-.}"
DOCKER_IMAGE_NAME="${DOCKER_IMAGE_NAME:-auto-built-image}"
STATE_FILE="/app/state/last_commit.txt"

echo "Git Repository: $GIT_REPO"
echo "Git Branch: $GIT_BRANCH"
echo "Dockerfile Path: $DOCKERFILE_PATH"
echo "Docker Image Name: $DOCKER_IMAGE_NAME"

# Function to configure git credentials
configure_git_credentials() {
    if [ -n "$GIT_PAT" ]; then
        # Extract hostname from git repository URL
        GIT_HOST=$(echo "$GIT_REPO" | sed -E 's|^(https?://)?([^/]+).*|\2|')
        
        if [ -z "$GIT_HOST" ]; then
            echo "WARNING: Could not extract hostname from GIT_REPO"
            GIT_HOST="github.com"
        fi
        
        # Configure git credential helper to use stored credentials
        git config --global credential.helper store
        # Store credentials securely (not in command line)
        echo "https://oauth2:${GIT_PAT}@${GIT_HOST}" > ~/.git-credentials 2>/dev/null || true
        chmod 600 ~/.git-credentials 2>/dev/null || true
    fi
}

# Clone or update repository
REPO_DIR="/app/repo"

if [ ! -d "$REPO_DIR/.git" ]; then
    echo "Cloning repository for the first time..."
    
    # Configure git credentials if PAT is provided
    configure_git_credentials
    
    # Clone without filtering output to preserve exit code
    git clone -b "$GIT_BRANCH" "$GIT_REPO" "$REPO_DIR"
    CLONE_STATUS=$?
    
    if [ $CLONE_STATUS -ne 0 ]; then
        echo "ERROR: Failed to clone repository (exit code: $CLONE_STATUS)"
        exit 1
    fi
else
    echo "Updating existing repository..."
    cd "$REPO_DIR"
    
    # Configure git credentials if PAT is provided
    configure_git_credentials
    
    git fetch origin "$GIT_BRANCH"
    git reset --hard "origin/$GIT_BRANCH"
fi

cd "$REPO_DIR"

# Get current commit hash
CURRENT_COMMIT=$(git rev-parse HEAD)
echo "Current commit: $CURRENT_COMMIT"

# Check if this is a new commit
if [ -f "$STATE_FILE" ]; then
    LAST_COMMIT=$(cat "$STATE_FILE")
    echo "Last processed commit: $LAST_COMMIT"
    
    if [ "$CURRENT_COMMIT" = "$LAST_COMMIT" ]; then
        echo "No changes detected. Skipping build."
        exit 0
    fi
else
    echo "First run - no previous commit found"
fi

echo "Changes detected! Starting Docker build..."

# Build Docker image
DOCKERFILE_FULL_PATH="$REPO_DIR/$DOCKERFILE_PATH/Dockerfile"

if [ ! -f "$DOCKERFILE_FULL_PATH" ]; then
    echo "ERROR: Dockerfile not found at $DOCKERFILE_FULL_PATH"
    exit 1
fi

BUILD_CONTEXT="$REPO_DIR/$DOCKERFILE_PATH"
echo "Building Docker image from $BUILD_CONTEXT..."

# Build with timestamp tag
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
IMAGE_TAG="${DOCKER_IMAGE_NAME}:${TIMESTAMP}"
IMAGE_LATEST="${DOCKER_IMAGE_NAME}:latest"

docker build -t "$IMAGE_TAG" -t "$IMAGE_LATEST" "$BUILD_CONTEXT"

if [ $? -eq 0 ]; then
    echo "Docker build successful!"
    echo "Tagged as: $IMAGE_TAG"
    echo "Tagged as: $IMAGE_LATEST"
    
    # Save current commit as last processed
    echo "$CURRENT_COMMIT" > "$STATE_FILE"
    echo "Commit hash saved to state file"
else
    echo "ERROR: Docker build failed"
    exit 1
fi

echo "==================================="
echo "Build process completed successfully"
echo "==================================="
