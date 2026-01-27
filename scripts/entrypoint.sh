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
if [ "$CHECK_INTERVAL" -eq 60 ]; then
    CRON_SCHEDULE="0 * * * *"  # Every hour
elif [ "$CHECK_INTERVAL" -lt 60 ]; then
    CRON_SCHEDULE="*/$CHECK_INTERVAL * * * *"  # Every N minutes
else
    # For intervals > 60 minutes, calculate hours
    HOURS=$((CHECK_INTERVAL / 60))
    CRON_SCHEDULE="0 */$HOURS * * *"  # Every N hours
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
