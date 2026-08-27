#!/usr/bin/env bash
# Run the app in development mode (hot-reload): Rust backend (axum) on
# FINANCES_BIND (default 127.0.0.1:3701) + Vite dev server on :3700 which
# proxies /api to the backend.
# Requires FINANCES_DATA_DIR — the directory where all app data is stored.

set -euo pipefail

if [ -z "${FINANCES_DATA_DIR:-}" ]; then
  echo "ERROR: FINANCES_DATA_DIR is not set." >&2
  echo "Example: export FINANCES_DATA_DIR=\"\$HOME/.finances-v2\"" >&2
  exit 1
fi

# Make sure Rust toolchain is on PATH (rustup installs to ~/.cargo/bin).
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# The backend runs with server/ as its build dir; normalize a relative
# FINANCES_DATA_DIR to an absolute path rooted at the project so both
# processes agree on it.
case "$FINANCES_DATA_DIR" in
  /*) ;;
  *) FINANCES_DATA_DIR="$PROJECT_ROOT/$FINANCES_DATA_DIR" ;;
esac
export FINANCES_DATA_DIR
export FINANCES_BIND="${FINANCES_BIND:-127.0.0.1:3701}"

# Kill the whole process group (backend + vite) on exit/Ctrl-C.
trap 'kill 0' EXIT INT TERM

cargo run --manifest-path server/Cargo.toml &

npm run dev
