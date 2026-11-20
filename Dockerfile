# Stage 1: Build TypeScript into a single zero-dependency ESM bundle
FROM node:22-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Stage 2: Minimal Alpine runtime (nodejs without npm/corepack + git + docker-cli/buildx)
FROM alpine:latest

# Set Docker API version to 1.43 to ensure compatibility with Synology Docker
ENV DOCKER_API_VERSION=1.43

RUN apk add --no-cache \
    tini \
    nodejs \
    git \
    docker-cli \
    docker-cli-buildx \
    docker-cli-compose \
    bash \
    curl \
    && rm -rf /var/cache/apk/*

WORKDIR /app

COPY --from=builder /build/dist/index.mjs /app/index.mjs
COPY scripts/check-and-build.sh /app/check-and-build.sh

RUN chmod +x /app/index.mjs /app/check-and-build.sh \
    && mkdir -p /app/state /var/log

EXPOSE 9000

ENTRYPOINT ["/sbin/tini", "--", "node", "/app/index.mjs"]
