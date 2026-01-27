# Syno-Builder Workflow

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Synology NAS                             │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           Syno-Builder Container                     │   │
│  │                                                       │   │
│  │  ┌──────────────┐    ┌────────────────────────┐    │   │
│  │  │ Cron Daemon  │───>│  check-and-build.sh   │    │   │
│  │  │ (scheduled)  │    │                        │    │   │
│  │  └──────────────┘    │  1. Git fetch/pull     │    │   │
│  │                      │  2. Check commit hash  │    │   │
│  │                      │  3. Build if changed   │    │   │
│  │                      └────────────────────────┘    │   │
│  │                                │                    │   │
│  │                                v                    │   │
│  │                      ┌────────────────────────┐    │   │
│  │                      │   State Persistence    │    │   │
│  │                      │  /app/state/last_      │    │   │
│  │                      │  commit.txt            │    │   │
│  │                      └────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────┘   │
│                                │                              │
│                                v                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Docker Socket                           │   │
│  │  /var/run/docker.sock (Docker-in-Docker)            │   │
│  └──────────────────────────────────────────────────────┘   │
│                                │                              │
│                                v                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         Built Docker Images                          │   │
│  │  - myapp:20240127-143000                            │   │
│  │  - myapp:latest                                      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                           │
                           │ git pull
                           v
                    ┌──────────────┐
                    │  Git Repo    │
                    │  (GitHub/    │
                    │  GitLab/etc) │
                    └──────────────┘
```

## Workflow Steps

### Step 1: Initial Startup
1. Container starts and runs `entrypoint.sh`
2. Validates required environment variables
3. Runs initial `check-and-build.sh`
4. Sets up cron job based on `CHECK_INTERVAL`

### Step 2: Repository Check (Runs on Schedule)
1. Clone repository (first time) or update existing clone
2. Authenticate using `GIT_PAT` if provided
3. Get current commit hash
4. Compare with last processed commit from state file

### Step 3: Change Detection
- **No Changes**: Skip build, exit cleanly
- **Changes Detected**: Proceed to build

### Step 4: Docker Build
1. Locate Dockerfile in repository at `DOCKERFILE_PATH`
2. Build Docker image using Docker-in-Docker
3. Tag with timestamp: `${DOCKER_IMAGE_NAME}:YYYYMMDD-HHMMSS`
4. Tag with latest: `${DOCKER_IMAGE_NAME}:latest`
5. Save current commit hash to state file

### Step 5: Scheduling
- Cron daemon runs check at configured interval
- Logs output to `/var/log/cron.log`
- Process repeats continuously

## Data Flow

```
Environment Variables → Configuration
         ↓
Git Repository → Clone/Update → Commit Hash Check
         ↓                            ↓
    [Changed?] ←────── Yes ────── Build Image
         ↓                            ↓
      No ↓                      Tag & Store
         ↓                            ↓
    Wait for Next Check ←────── Save State
```

## File Locations

| Path | Purpose |
|------|---------|
| `/app/repo/` | Cloned git repository |
| `/app/state/last_commit_<branch>.txt` | Last processed commit hash per branch |
| `/app/secrets/pat` | Mounted PAT file (optional) |
| `/var/log/cron.log` | Cron job execution logs |
| `~/.git-credentials` | Stored git credentials (secure) |

## Security Considerations

1. **Credentials**: Stored in `~/.git-credentials` with 600 permissions
2. **Docker Socket**: Shared with host for Docker-in-Docker
3. **State Volume**: Persistent across container restarts
4. **No Logging**: PAT never appears in logs or output

## Customization Points

- **CHECK_INTERVAL**: Adjust polling frequency
- **DOCKERFILE_PATH**: Build from subdirectory
- **GIT_BRANCH**: Monitor different branches
- **Multiple Instances**: Run multiple containers for different repos
