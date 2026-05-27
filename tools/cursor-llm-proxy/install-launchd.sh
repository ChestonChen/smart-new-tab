#!/usr/bin/env bash
# Install / uninstall the cursor-llm-proxy launchd agent.
#
#   bash tools/cursor-llm-proxy/install-launchd.sh           # install + start
#   bash tools/cursor-llm-proxy/install-launchd.sh status    # show status + recent log
#   bash tools/cursor-llm-proxy/install-launchd.sh restart   # bounce the agent
#   bash tools/cursor-llm-proxy/install-launchd.sh uninstall # stop + remove

set -eu

LABEL="com.smartnewtab.cursorproxy"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$DIR/$LABEL.plist"
DEST_DIR="$HOME/Library/LaunchAgents"
DEST="$DEST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/smart-new-tab"
# Dedicated empty workspace dir so cursor-agent doesn't index unrelated files.
WORKSPACE_DIR="$HOME/.cache/cursor-llm-proxy"

cmd="${1:-install}"

case "$cmd" in
  install)
    mkdir -p "$DEST_DIR" "$LOG_DIR" "$WORKSPACE_DIR"
    # Substitute absolute paths into the template.
    sed \
      -e "s|__START_SH__|$DIR/start.sh|g" \
      -e "s|__LOG_DIR__|$LOG_DIR|g" \
      -e "s|__WORKSPACE_DIR__|$WORKSPACE_DIR|g" \
      "$TEMPLATE" > "$DEST"
    chmod 644 "$DEST"

    # Unload any previous version, then load fresh.
    launchctl unload "$DEST" 2>/dev/null || true
    launchctl load -w "$DEST"

    sleep 1
    echo "[OK] installed $LABEL"
    echo "     plist : $DEST"
    echo "     logs  : $LOG_DIR/"
    echo
    launchctl list | grep -E "^[^[:space:]]+\s+[^[:space:]]+\s+$LABEL$" || echo "(not running yet — check $LOG_DIR/cursor-llm-proxy.err.log)"
    echo
    echo "Test it:"
    echo "  curl http://127.0.0.1:8788/health"
    ;;

  uninstall)
    if [[ -f "$DEST" ]]; then
      launchctl unload "$DEST" 2>/dev/null || true
      rm -f "$DEST"
      echo "[OK] removed $DEST"
    else
      echo "[SKIP] $DEST not present"
    fi
    ;;

  restart)
    if [[ ! -f "$DEST" ]]; then
      echo "[ERR] $DEST not installed yet — run: $0 install" >&2
      exit 1
    fi
    launchctl unload "$DEST" 2>/dev/null || true
    launchctl load -w "$DEST"
    sleep 1
    echo "[OK] restarted $LABEL"
    ;;

  status)
    echo "--- launchctl ---"
    launchctl list | (grep "$LABEL" || echo "(not loaded)")
    echo
    echo "--- /health ---"
    curl -sS --max-time 2 http://127.0.0.1:8788/health || echo "(proxy not responding)"
    echo
    echo
    echo "--- last 20 err log lines ---"
    tail -n 20 "$LOG_DIR/cursor-llm-proxy.err.log" 2>/dev/null || echo "(no err log yet)"
    ;;

  *)
    echo "usage: $0 [install|uninstall|restart|status]" >&2
    exit 1
    ;;
esac
