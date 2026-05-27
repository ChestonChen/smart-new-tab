# cursor-llm-proxy

A tiny localhost-only HTTP server that exposes an **OpenAI-compatible**
`POST /v1/chat/completions` endpoint and answers every request by shelling
out to [`cursor-agent`](https://docs.cursor.com/cli) in headless mode.

That lets the Smart New Tab extension (or any other OpenAI-shaped client)
use your already-logged-in Cursor account for inference — **no API key
required, no cost outside your existing Cursor subscription.**

```
┌─────────────────┐  POST /v1/chat/completions   ┌─────────────────┐  spawn   ┌──────────────┐
│ smart-new-tab   │ ───────────────────────────→ │ cursor-llm-proxy│ ──────→  │ cursor-agent │
│  (extension)    │ ←── OpenAI-shape JSON ───────│  (Node, no dep) │ ←── JSON │  (headless)  │
└─────────────────┘                              └─────────────────┘          └──────────────┘
```

Zero npm dependencies: just Node 18+ (`node:http`, `node:child_process`).

---

## Prerequisites

1. **Node 18+** (`node --version`).
2. **`cursor-agent`** installed and logged in:
   ```bash
   curl https://cursor.com/install -fsSL | bash
   cursor-agent login          # opens browser, log in with your Cursor account
   cursor-agent status         # should print: Logged in as <you>
   ```

## Quick start (recommended)

In any Cursor / Terminal window:

```bash
cd path/to/smart-new-tab
bash tools/cursor-llm-proxy/start.sh
```

You should see something like:

```
[hh:mm:ss] cursor-llm-proxy listening on http://127.0.0.1:8788
[hh:mm:ss]   model     = sonnet-4
[hh:mm:ss]   workspace = /Users/you/.cache/cursor-llm-proxy
```

Smoke test in another shell:

```bash
curl http://127.0.0.1:8788/health
# {"ok":true,"model":"sonnet-4","queueDepth":0}
```

The proxy keeps running until you stop it (`Ctrl-C` or close the terminal).
Each chat-completion call takes roughly **5–15 seconds** under this mode.

## Wire it into the Smart New Tab extension

1. Open the extension's options page (`chrome://extensions` → Smart New Tab → *Details* → *Extension options*).
2. Under **AI grouping**:
   - **Provider**: `Custom`
   - **Endpoint**: `http://127.0.0.1:8788/v1/chat/completions`
   - **Model**: `sonnet-4` (or any model that `cursor-agent --list-models` shows)
   - **API key**: leave blank
3. Toggle **AI grouping** on, save, and open a new tab.

The dashboard will paint heuristic groups instantly and silently fold in
the LLM's groupings ~10 seconds later. If the proxy is unreachable or
takes too long the dashboard keeps the heuristic result — you'll never
see a broken UI.

## Optional: auto-start with launchd

```bash
bash tools/cursor-llm-proxy/install-launchd.sh install     # install + start
bash tools/cursor-llm-proxy/install-launchd.sh status      # health + recent logs
bash tools/cursor-llm-proxy/install-launchd.sh restart     # bounce
bash tools/cursor-llm-proxy/install-launchd.sh uninstall   # stop + remove
```

The launchd agent is installed to
`~/Library/LaunchAgents/com.smartnewtab.cursorproxy.plist` and logs to
`~/Library/Logs/smart-new-tab/`.

### ⚠ Performance caveat

When the proxy is started by **launchd**, each `cursor-agent` invocation
takes roughly **60 seconds** instead of 5. The slowdown is inside
`cursor-agent` itself (likely tied to the macOS SecuritySession context
that launchd-spawned processes inherit) and we have not found a clean
wrapper-level fix. If you care about latency, prefer the **manual
quick-start** above.

If you only ever do AI grouping a couple of times a day, launchd is
still fine — the dashboard's heuristic groups appear immediately and the
LLM result simply overlays whenever it arrives.

## Configuration (env vars)

| Variable           | Default            | Notes                                           |
| ------------------ | ------------------ | ----------------------------------------------- |
| `PORT`             | `8788`             | Bind port on `127.0.0.1`.                       |
| `MODEL`            | `sonnet-4`         | Default model when caller doesn't set one.      |
| `WORKSPACE_DIR`    | `process.cwd()`    | Workspace passed to `cursor-agent --workspace`. |
| `TIMEOUT_MS`       | `90000`            | Per-request timeout.                            |
| `CURSOR_AGENT_BIN` | `cursor-agent`     | Override path if not on `PATH`.                 |

Set them inline:

```bash
PORT=9000 MODEL=gpt-5 bash tools/cursor-llm-proxy/start.sh
```

For launchd, edit `EnvironmentVariables` in
`~/Library/LaunchAgents/com.smartnewtab.cursorproxy.plist`, then
`./install-launchd.sh restart`.

## Endpoints

| Method | Path                   | What it does                                                     |
| ------ | ---------------------- | ---------------------------------------------------------------- |
| `GET`  | `/health`              | Liveness probe. Returns `{ok, model, queueDepth}`.               |
| `GET`  | `/v1/models`           | Static list of common Cursor model ids (compat with some clients). |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions, sync only. Streaming is **not** supported. |

The chat completion response is OpenAI-shaped with one extra debug
field:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "sonnet-4",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 35, "total_tokens": 35 },
  "_cursor": { "session_id": "...", "duration_ms": 4501 }
}
```

`_cursor.duration_ms` is the time `cursor-agent` itself reported (i.e.
not counting Node spawn overhead). Useful for performance triage.

## Privacy / Safety

- Binds **only** to `127.0.0.1`. Nothing exposed to the network.
- All cursor-agent invocations use `--mode ask --trust`, meaning **read-only Q&A** — the agent cannot write files or run shell commands.
- The workspace passed to `--workspace` is `~/.cache/cursor-llm-proxy/` by default — an empty dedicated directory, so cursor-agent has no codebase to introspect.
- The proxy does **not** persist requests or responses to disk; only the
  one-line per-request log goes to stderr (and to
  `~/Library/Logs/smart-new-tab/cursor-llm-proxy.err.log` under launchd).

## Limits

- **Sequential queue.** Requests are processed one-at-a-time;
  `cursor-agent` is heavy and parallelism doesn't pay off.
- **No streaming.** OpenAI clients that set `stream: true` will get a
  non-streamed reply and must tolerate it.
- **macOS only for launchd.** The manual flow works on any OS with
  Node + cursor-agent.

## Troubleshooting

| Symptom                                                          | Likely cause / fix                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Error: Authentication required. Please run 'agent login' first` | Run `cursor-agent login` and retry.                                                                            |
| `Workspace Trust Required`                                       | Already worked around with `--trust`. If you see it, your `cursor-agent` is too old; reinstall.                |
| `EADDRINUSE 127.0.0.1:8788`                                      | Another instance already running. `lsof -nP -iTCP:8788 -sTCP:LISTEN` to find it, kill, or change `PORT`.       |
| 60s+ per request                                                 | You're running under launchd. See the performance caveat above. Use manual start for ~5s.                     |
| Extension says *"LLM classify failed, falling back to heuristics"* | Check `~/Library/Logs/smart-new-tab/cursor-llm-proxy.err.log` (launchd) or the terminal where you started it. |

## Uninstall everything

```bash
# stop + remove launchd agent
bash tools/cursor-llm-proxy/install-launchd.sh uninstall

# remove cursor-agent itself (optional)
rm -rf ~/.local/bin/cursor-agent ~/.local/bin/agent ~/.local/share/cursor-agent
```

That's it. Toggle off **AI grouping** in the extension's options if you
no longer want the dashboard to call the proxy.
