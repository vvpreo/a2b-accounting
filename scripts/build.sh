#!/usr/bin/env bash
# Release build without Docker: frontend to dist/, backend to
# server/target/release/a2b-accounting-server. For the production image use
# `docker build .` instead (see Dockerfile).

set -euo pipefail

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

npm run build
cargo build --release --manifest-path server/Cargo.toml

echo
echo "Frontend: $PROJECT_ROOT/dist/"
echo "Backend:  $PROJECT_ROOT/server/target/release/a2b-accounting-server"
echo "Run:      FINANCES_STATIC_DIR=dist FINANCES_DATA_DIR=... server/target/release/a2b-accounting-server"
