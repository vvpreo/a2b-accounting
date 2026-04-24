#!/usr/bin/env bash
# Run the app in development mode (hot-reload).
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

# Tauri dev runs `cargo run` from src-tauri/, so a relative FINANCES_DATA_DIR
# would resolve inside src-tauri/ and trigger the dev watcher in an infinite
# rebuild loop. Normalize to an absolute path rooted at the project.
case "$FINANCES_DATA_DIR" in
  /*) ;;
  *) FINANCES_DATA_DIR="$PROJECT_ROOT/$FINANCES_DATA_DIR" ;;
esac
export FINANCES_DATA_DIR

exec npm run tauri dev
