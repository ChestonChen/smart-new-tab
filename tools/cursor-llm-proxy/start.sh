#!/usr/bin/env bash
# cursor-llm-proxy launcher. Used by both manual `./start.sh` and launchd.
# Sets up PATH so launchd's minimal environment can still find node and
# cursor-agent.

set -eu

# Resolve this script's directory regardless of how it is invoked.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Locate node:
#   1) prefer nvm's default if available
#   2) fall back to Homebrew (Apple silicon + Intel)
#   3) fall back to /usr/local/bin
NODE_BIN=""
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  fi
fi
if [[ -z "$NODE_BIN" ]]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [[ -x "$p" ]]; then NODE_BIN="$p"; break; fi
  done
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "[cursor-llm-proxy] could not find node binary" >&2
  exit 1
fi

# Make sure cursor-agent is on PATH.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Make sure common locale/terminal vars are set even under launchd's
# minimal env. cursor-agent doesn't strictly need these but other CLI
# tools spawned in the future might.
export TERM="${TERM:-dumb}"
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

# NOTE on performance
# ===================
# When started from an interactive terminal, each cursor-agent invocation
# takes ~5s. When started from launchd (RunAtLoad), each invocation
# takes ~60s. The difference is *inside* cursor-agent itself — most
# likely tied to the macOS SecuritySession context launchd processes
# inherit. We have not found a reliable fix from the wrapper.
#
# If you need fast inference, start the proxy manually in a Cursor /
# Terminal window:
#     bash tools/cursor-llm-proxy/start.sh
# instead of relying on the launchd agent.

exec "$NODE_BIN" "$DIR/server.js" "$@"
