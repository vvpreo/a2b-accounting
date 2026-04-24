#!/usr/bin/env bash
# Build a release bundle of the desktop app.
# Produces installers under src-tauri/target/release/bundle/.

set -euo pipefail

# Make sure Rust toolchain is on PATH (rustup installs to ~/.cargo/bin).
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

cd "$(dirname "$0")/.."

exec npm run tauri build
