#!/usr/bin/env bash
# Gracefully stop the running application before a new deployment.
set -euo pipefail

APP_NAME="techbigsolutions-node-api"

echo "==> [stop_server] Stopping application..."

if command -v pm2 &> /dev/null; then
  pm2 stop "$APP_NAME" || true
  pm2 delete "$APP_NAME" || true
else
  echo "PM2 not found — nothing to stop."
fi

echo "==> [stop_server] Done."
