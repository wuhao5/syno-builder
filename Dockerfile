FROM alpine:latest

# Install required packages
RUN apk add --no-cache \
    git \
    docker-cli \
    bash \
    curl \
    dcron \
    && rm -rf /var/cache/apk/*

# Create working directory
WORKDIR /app

# Copy scripts
COPY scripts/entrypoint.sh /app/entrypoint.sh
COPY scripts/check-and-build.sh /app/check-and-build.sh

# Make scripts executable
RUN chmod +x /app/entrypoint.sh /app/check-and-build.sh

# Create directory for state tracking
RUN mkdir -p /app/state

# Set up cron log file
RUN mkdir -p /var/log && touch /var/log/cron.log

ENTRYPOINT ["/app/entrypoint.sh"]
