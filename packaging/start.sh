#!/usr/bin/env sh
# OnPrem Transformation Planner - start the server (release package). Usage: ./start.sh [port]
cd "$(dirname "$0")"
PORT="${1:-9080}"
command -v node >/dev/null 2>&1 || { echo "Node.js 22.13+ is required - https://nodejs.org"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || { echo "Node.js 22.13 or newer is required (found $(node -v))"; exit 1; }
exec node --disable-warning=ExperimentalWarning server.mjs --port "$PORT"
