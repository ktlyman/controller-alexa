#!/usr/bin/env bash
#
# Start the Alexa Agent Tool server and expose it via Tailscale Funnel.
#
# Usage:
#   ./scripts/start.sh
#
# This runs two things:
#   1. The local Node server on port 3100
#   2. Tailscale Funnel exposing port 3100 to the internet
#
# Your Funnel URL (stable, never changes):
#   https://<your-machine>.<your-tailnet>.ts.net
#
# To see your Funnel URL:
#   tailscale funnel status

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

PORT="${LOCAL_SERVER_PORT:-3100}"

# Check tailscale is available
if ! command -v tailscale &> /dev/null; then
  echo "Error: tailscale CLI not found. Install Tailscale first."
  exit 1
fi

# Show the Funnel URL
FUNNEL_HOSTNAME=$(tailscale status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')
if [ -n "$FUNNEL_HOSTNAME" ]; then
  echo "Tailscale Funnel URL: https://${FUNNEL_HOSTNAME}"
  echo "Lambda FORWARD_URL:   https://${FUNNEL_HOSTNAME}/directive"
  echo ""
fi

# Build if needed
if [ ! -f dist/server.js ]; then
  echo "==> Building..."
  npm run build
fi

# Start Tailscale Funnel in the background
echo "==> Starting Tailscale Funnel on port ${PORT}..."
tailscale funnel "${PORT}" &
FUNNEL_PID=$!

# Start the server
echo "==> Starting Alexa Agent Tool server..."
node dist/server.js &
SERVER_PID=$!

# Cleanup on exit
cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$SERVER_PID" 2>/dev/null || true
  kill "$FUNNEL_PID" 2>/dev/null || true
  tailscale funnel off 2>/dev/null || true
  wait
}
trap cleanup EXIT INT TERM

echo ""
echo "Running. Press Ctrl+C to stop."
wait
