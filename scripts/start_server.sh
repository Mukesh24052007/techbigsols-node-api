#!/usr/bin/env bash
# Start the Node.js server via PM2 for process management.
set -euo pipefail

APP_DIR="/home/ec2-user/app"
APP_NAME="techbigsolutions-node-api"

echo "==> [start_server] Starting application..."
cd "$APP_DIR"

# Install PM2 globally if not already present
if ! command -v pm2 &> /dev/null; then
  npm install -g pm2
fi

# Start or reload using PM2
pm2 describe "$APP_NAME" > /dev/null 2>&1 \
  && pm2 reload "$APP_NAME" \
  || pm2 start src/server.js --name "$APP_NAME" --no-autorestart

# Persist PM2 process list across reboots
pm2 save

echo "==> [start_server] Done."
