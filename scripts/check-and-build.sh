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
GIT_PAT_FILE="${GIT_PAT_FILE:-/app/secrets/pat}"
POST_BUILD_SCRIPT="${POST_BUILD_SCRIPT:-}"
STATE_DIR="/app/state"

echo "Git Repository: $GIT_REPO"
echo "Git Branch(es): $GIT_BRANCH"
echo "Dockerfile Path: $DOCKERFILE_PATH"
echo "Docker Image Name: $DOCKER_IMAGE_NAME"
if [ -n "$POST_BUILD_SCRIPT" ]; then
    echo "Post-build script: $POST_BUILD_SCRIPT"
fi

# Function to read PAT from file or environment
read_git_pat() {
    if [ -f "$GIT_PAT_FILE" ]; then
        echo "Reading PAT from file: $GIT_PAT_FILE"
        GIT_PAT=$(cat "$GIT_PAT_FILE" | tr -d '\n\r ')
    elif [ -n "$GIT_PAT" ]; then
        echo "Using PAT from environment variable"
    else
        echo "No PAT configured (public repository access only)"
        GIT_PAT=""
    fi
}

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

# Read PAT before configuring credentials
read_git_pat

# Clone or update repository
REPO_DIR="/app/repo"

if [ ! -d "$REPO_DIR/.git" ]; then
    echo "Cloning repository for the first time..."
    
    # Configure git credentials if PAT is provided
    configure_git_credentials
    
    # Clone without filtering output to preserve exit code
    # Clone with first branch only, will fetch others later
    FIRST_BRANCH=$(echo "$GIT_BRANCH" | cut -d',' -f1 | xargs)
    git clone -b "$FIRST_BRANCH" "$GIT_REPO" "$REPO_DIR"
    CLONE_STATUS=$?
    
    if [ $CLONE_STATUS -ne 0 ]; then
        echo "ERROR: Failed to clone repository (exit code: $CLONE_STATUS)"
        exit 1
    fi
else
    echo "Updating existing repository..."
fi

cd "$REPO_DIR"

# Configure git credentials if PAT is provided (for existing repos)
configure_git_credentials

# Process each branch
IFS=',' read -ra BRANCHES <<< "$GIT_BRANCH"
CHANGES_DETECTED=false

for BRANCH in "${BRANCHES[@]}"; do
    BRANCH=$(echo "$BRANCH" | xargs)  # Trim whitespace
    echo ""
    echo "--- Processing branch: $BRANCH ---"
    
    # Fetch and update branch
    git fetch origin "$BRANCH"
    git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
    git reset --hard "origin/$BRANCH"
    
    # Get current commit hash
    CURRENT_COMMIT=$(git rev-parse HEAD)
    echo "Current commit: $CURRENT_COMMIT"
    
    # Check if this is a new commit
    STATE_FILE="$STATE_DIR/last_commit_${BRANCH}.txt"
    if [ -f "$STATE_FILE" ]; then
        LAST_COMMIT=$(cat "$STATE_FILE")
        echo "Last processed commit: $LAST_COMMIT"
        
        if [ "$CURRENT_COMMIT" = "$LAST_COMMIT" ]; then
            echo "No changes detected on branch $BRANCH"
            continue
        fi
    else
        echo "First run for branch $BRANCH - no previous commit found"
    fi
    
    echo "Changes detected on branch $BRANCH! Starting Docker build..."
    CHANGES_DETECTED=true
    
    # Build Docker image
    DOCKERFILE_FULL_PATH="$REPO_DIR/$DOCKERFILE_PATH/Dockerfile"
    
    if [ ! -f "$DOCKERFILE_FULL_PATH" ]; then
        echo "ERROR: Dockerfile not found at $DOCKERFILE_FULL_PATH"
        continue
    fi
    
    BUILD_CONTEXT="$REPO_DIR/$DOCKERFILE_PATH"
    echo "Building Docker image from $BUILD_CONTEXT..."
    
    # Build with timestamp and branch tag
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    BRANCH_SAFE=$(echo "$BRANCH" | tr '/' '-')
    IMAGE_TAG="${DOCKER_IMAGE_NAME}:${BRANCH_SAFE}-${TIMESTAMP}"
    IMAGE_BRANCH="${DOCKER_IMAGE_NAME}:${BRANCH_SAFE}"
    
    docker build -t "$IMAGE_TAG" -t "$IMAGE_BRANCH" "$BUILD_CONTEXT"
    
    if [ $? -eq 0 ]; then
        echo "Docker build successful!"
        echo "Tagged as: $IMAGE_TAG"
        echo "Tagged as: $IMAGE_BRANCH"
        
        # Tag as latest only for main/master branch
        if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
            IMAGE_LATEST="${DOCKER_IMAGE_NAME}:latest"
            docker tag "$IMAGE_TAG" "$IMAGE_LATEST"
            echo "Tagged as: $IMAGE_LATEST"
        fi
        
        # Run post-build script if configured
        if [ -n "$POST_BUILD_SCRIPT" ] && [ -f "$POST_BUILD_SCRIPT" ]; then
            echo ""
            echo "Running post-build script: $POST_BUILD_SCRIPT"
            
            # Make script executable if not already
            if ! chmod +x "$POST_BUILD_SCRIPT" 2>/dev/null; then
                echo "WARNING: Could not make post-build script executable (may already be executable or permission denied)"
            fi
            
            # Run script in background with setsid to detach from parent process
            # This ensures processes like 'docker compose up -d' won't be killed when this script exits
            # Set environment variables that the post-build script might need
            export IMAGE_TAG IMAGE_BRANCH IMAGE_LATEST BRANCH DOCKER_IMAGE_NAME REPO_DIR
            
            # Determine log file location (prefer /var/log, fallback to /tmp)
            POST_BUILD_LOG="/var/log/post-build.log"
            if [ ! -w "/var/log" ]; then
                POST_BUILD_LOG="/tmp/post-build.log"
            fi
            
            # Use nohup and setsid for full detachment
            if command -v setsid >/dev/null 2>&1; then
                # Run with setsid (preferred method for full detachment)
                setsid "$POST_BUILD_SCRIPT" > "$POST_BUILD_LOG" 2>&1 &
            else
                # Fallback to nohup if setsid is not available
                nohup "$POST_BUILD_SCRIPT" > "$POST_BUILD_LOG" 2>&1 &
            fi
            
            POST_BUILD_PID=$!
            echo "Post-build script started with PID $POST_BUILD_PID (detached)"
            echo "Logs: $POST_BUILD_LOG"
        elif [ -n "$POST_BUILD_SCRIPT" ] && [ ! -f "$POST_BUILD_SCRIPT" ]; then
            echo "WARNING: POST_BUILD_SCRIPT is set but file not found: $POST_BUILD_SCRIPT"
        fi
        
        # Save current commit as last processed
        echo "$CURRENT_COMMIT" > "$STATE_FILE"
        echo "Commit hash saved to state file"
    else
        echo "ERROR: Docker build failed for branch $BRANCH"
    fi
done

if [ "$CHANGES_DETECTED" = false ]; then
    echo ""
    echo "No changes detected on any branch. Skipping build."
    exit 0
fi

echo ""
echo "==================================="
echo "Build process completed successfully"
echo "==================================="
