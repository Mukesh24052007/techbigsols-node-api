#!/usr/bin/env bash
# Validate the service is running and healthy after deployment.
set -euo pipefail

PORT="${PORT:-3000}"
HEALTH_URL="http://localhost:${PORT}/api/health"
MAX_RETRIES=10
SLEEP_SECONDS=3

echo "==> [validate_service] Checking health at ${HEALTH_URL}..."

for i in $(seq 1 $MAX_RETRIES); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)
  if [ "$STATUS" = "200" ]; then
    echo "==> [validate_service] Health check passed (HTTP 200)."
    exit 0
  fi
  echo "    Attempt ${i}/${MAX_RETRIES} — got HTTP ${STATUS}. Retrying in ${SLEEP_SECONDS}s..."
  sleep $SLEEP_SECONDS
done

echo "==> [validate_service] FAILED — service did not respond with HTTP 200 after ${MAX_RETRIES} attempts."
exit 1
