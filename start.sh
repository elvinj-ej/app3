#!/usr/bin/env sh
# On-Prem Footprint - run from a source checkout. Usage: ./start.sh [port]
set -e
cd "$(dirname "$0")"
PORT="${1:-8080}"
command -v node >/dev/null 2>&1 || { echo "Node.js 22.13+ is required - https://nodejs.org"; exit 1; }
[ -d node_modules ] || { echo "Installing dependencies (first run only)..."; npm install; }
echo "Building..."
npx vite build --logLevel warn
npx vite build -c vite.server.config.ts --logLevel warn
exec node --disable-warning=ExperimentalWarning build/server/server.mjs --port "$PORT"
