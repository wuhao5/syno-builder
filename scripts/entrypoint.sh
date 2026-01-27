#!/bin/bash
set -e

echo "Starting Syno-Builder Auto Git Puller and Docker Builder"
echo "========================================================="

# Validate required environment variables
if [ -z "$GIT_REPO" ]; then
    echo "ERROR: GIT_REPO environment variable is required"
    echo "Please set it to your git repository URL"
    exit 1
fi

# Set defaults
CHECK_INTERVAL="${CHECK_INTERVAL:-60}"  # Default: 60 minutes
GIT_BRANCH="${GIT_BRANCH:-main}"

echo "Configuration:"
echo "  Git Repository: $GIT_REPO"
echo "  Git Branch: $GIT_BRANCH"
echo "  Check Interval: $CHECK_INTERVAL minutes"
echo ""

# Run initial check
echo "Running initial build check..."
/app/check-and-build.sh
INITIAL_STATUS=$?

if [ $INITIAL_STATUS -eq 0 ]; then
    echo "Initial check completed successfully"
else
    echo "WARNING: Initial check failed with status $INITIAL_STATUS"
fi

echo ""
echo "Setting up cron job to run every $CHECK_INTERVAL minutes..."

# Create cron job
# Convert minutes to cron format
# Note: Cron has limitations - it can only handle intervals that divide evenly into 60 minutes
# For intervals > 60, we convert to hours (e.g., 120 min = every 2 hours)
if [ "$CHECK_INTERVAL" -eq 60 ]; then
    CRON_SCHEDULE="0 * * * *"  # Every hour
elif [ "$CHECK_INTERVAL" -lt 60 ]; then
    # Check if interval divides evenly into 60
    if [ $((60 % CHECK_INTERVAL)) -eq 0 ]; then
        CRON_SCHEDULE="*/$CHECK_INTERVAL * * * *"  # Every N minutes
    else
        echo "WARNING: CHECK_INTERVAL ($CHECK_INTERVAL) does not divide evenly into 60"
        echo "Using closest valid interval: every $CHECK_INTERVAL minutes (may not be exact)"
        CRON_SCHEDULE="*/$CHECK_INTERVAL * * * *"  # Every N minutes (cron will round)
    fi
else
    # For intervals >= 60 minutes, convert to hours
    if [ $((CHECK_INTERVAL % 60)) -eq 0 ]; then
        HOURS=$((CHECK_INTERVAL / 60))
        CRON_SCHEDULE="0 */$HOURS * * *"  # Every N hours on the hour
    else
        echo "WARNING: CHECK_INTERVAL ($CHECK_INTERVAL) is not a multiple of 60"
        echo "Rounding down to nearest hour"
        HOURS=$((CHECK_INTERVAL / 60))
        if [ "$HOURS" -eq 0 ]; then
            HOURS=1
        fi
        CRON_SCHEDULE="0 */$HOURS * * *"  # Every N hours
    fi
fi

echo "$CRON_SCHEDULE /app/check-and-build.sh >> /var/log/cron.log 2>&1" > /etc/crontabs/root

echo "Cron schedule: $CRON_SCHEDULE"
echo "Logs will be written to /var/log/cron.log"
echo ""

# Start cron in foreground
echo "Starting cron daemon..."
echo "Container is now running. Press Ctrl+C to stop."
echo "========================================================="

# Start crond and tail the log
crond -f -l 2 &
CROND_PID=$!

# Also tail the cron log
tail -f /var/log/cron.log &
TAIL_PID=$!

# Wait for signals
trap "echo 'Shutting down...'; kill $CROND_PID $TAIL_PID 2>/dev/null; exit 0" SIGTERM SIGINT

# Keep container running
wait $CROND_PID
