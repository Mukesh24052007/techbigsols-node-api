#!/usr/bin/env bash
# Runs after the revision is copied. Install npm dependencies.
set -euo pipefail

APP_DIR="/home/ec2-user/app"

echo "==> [after_install] Installing production dependencies..."
cd "$APP_DIR"
npm ci --omit=dev

echo "==> [after_install] Done."
