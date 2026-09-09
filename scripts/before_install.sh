#!/usr/bin/env bash
# Runs before the new revision is copied to the instance.
# Install/update Node.js if required and stop the existing app process.
set -euo pipefail

echo "==> [before_install] Checking Node.js..."
node --version || {
  echo "Node.js not found — installing via nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
}

echo "==> [before_install] Done."
