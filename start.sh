#!/usr/bin/env sh
# On-Prem Footprint - one-command start (macOS / Linux).  Usage: ./start.sh [port]
set -e
cd "$(dirname "$0")"
PORT="${1:-8080}"
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed - get the LTS from https://nodejs.org"; exit 1; }
[ -d node_modules ] || { echo "Installing dependencies (first run only)..."; npm install; }
echo "Building the app..."
npx vite build --logLevel warn
echo "On-Prem Footprint running at http://localhost:$PORT  (Ctrl+C to stop)"
exec npx vite preview --host 0.0.0.0 --port "$PORT" --strictPort
