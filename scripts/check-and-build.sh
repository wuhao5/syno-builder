#!/bin/sh
# Compatibility shim for manual one-shot runs:
#   docker exec syno-builder /app/check-and-build.sh
exec node /app/index.mjs --once "$@"
