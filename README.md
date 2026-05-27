# Smart New Tab

> An Arc-inspired new tab dashboard for Chrome that **aggregates, groups, and de-duplicates every tab across every window** — so you can actually find things when you have 50+ tabs open.

## Why

Browser tabs are where modern work happens, and they pile up fast. Smart New Tab replaces the blank new tab page with a single dashboard that tells you, at a glance:

- **What you have open** — every tab, every window, grouped by domain or category.
- **What you can close** — duplicates, stale tabs, anything you forgot about.
- **What you saved last week** — a built-in impact panel quantifies the time you reclaim.

Everything runs locally. No tracking, no analytics, no ads. Optional AI grouping only ever sees `host` + `title` — never the full URL, query string, cookies, or page content.

## Features

### Tab management
- **Unified view** of every open tab across every Chrome window.
- **Smart grouping** — by site name (default) or by heuristic category (Development, Docs, Communication, Video, Shopping, Design, Cloud, …).
- **Duplicate detection** with URL normalization (UTM params / fragments / trailing slash stripped). Close one duplicate or all of them.
- **Custom rules** — map any `host` / URL / title substring to your own category and emoji.
- **AI grouping (optional)** — OpenAI, Anthropic, local Ollama, or any OpenAI-compatible endpoint. Privacy-preserving payload.
- **Pinned tabs strip** — Chrome-pinned tabs surface in a dedicated row above the groups.
- **Drag and drop reclassification** — drag a tab onto any category group to persist a custom rule.

### Productivity
- **Cmd / Ctrl + K command palette** — fuzzy search tabs, run `/close youtube`, `/dedupe`, `/restore`, `/bookmark`, switch theme, save workspace, and more.
- **Multi-select** — Cmd / Ctrl-click to pick multiple tabs, then bulk close or bulk bookmark from the floating action bar. Esc to clear.
- **Search with Google fallback** — type to filter; if nothing matches, press Enter to send the query straight to Google.
- **Recently closed** — restore the last few tabs you closed with one click (powered by `chrome.sessions`).
- **Workspaces** — snapshot the current set of tabs under a name, restore later, rename or delete from the dashboard.

### Awareness
- **Stale-tab detection** — tabs you haven't touched in N days get an ⏰ badge and surface in a top banner with a one-click bulk close.
- **Impact panel** — duplicates closed, tabs restored, bulk actions, and estimated time saved, each with a 7-day mini sparkline.
- **Weekly report modal** — once per ISO week the dashboard greets you with a summary of last week's wins.

### Look and feel
- **Arc-inspired UI** — glassmorphism, mesh gradient backdrop, per-group accent hues derived from a stable hash of the label.
- **Theme picker** — Lavender (default), Ocean, Forest, Sunset; respects `prefers-color-scheme`.
- **One Google-shaped button** for when you really do just want google.com.

## Install (developer mode)

1. Clone or download this repo.
2. Open `chrome://extensions` in Chrome / Edge / Brave.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Open a new tab.

To uninstall: same page, **Remove**.

## Configure

Open `chrome://extensions`, click **Details** on the Smart New Tab card, then **Extension options** (the dashboard footer link was removed for a cleaner look). Most settings sync via `chrome.storage.sync`.

### Custom rules

In Settings → *Custom rules*:

| Match              | Category    | Emoji |
| ------------------ | ----------- | ----- |
| `notion.so`        | Notes       | 📝    |
| `figma.com`        | Design      | 🎨    |
| `meego.byted.org`  | Tickets     | 🎟️    |

Earlier rules win. Drag-and-drop reclassification on the dashboard appends to this list automatically.

### AI grouping

In Settings → *AI grouping*, toggle on and fill the provider config:

| Provider  | Endpoint (leave blank for default)            | Model example                | API key          |
| --------- | --------------------------------------------- | ---------------------------- | ---------------- |
| OpenAI    | `https://api.openai.com/v1/chat/completions`  | `gpt-4o-mini`                | required         |
| Anthropic | `https://api.anthropic.com/v1/messages`       | `claude-3-5-haiku-latest`    | required         |
| Ollama    | `http://localhost:11434/api/chat`             | `llama3.2` / `qwen2.5`       | not needed       |
| Custom    | any OpenAI-compatible URL                     | depends                      | optional         |

**Privacy contract:** only the `host` and the trimmed `title` of each tab are transmitted. Full URL, query string, cookies, and page content never leave your machine. If the LLM request fails, the dashboard silently falls back to the heuristic groups.

### Use Cursor as your local LLM (no API key)

If you already pay for Cursor, you can route AI grouping through your
existing Cursor subscription via the bundled
[`cursor-llm-proxy`](tools/cursor-llm-proxy/) — a 200-line Node script
that exposes an OpenAI-compatible endpoint on `127.0.0.1:8788` and
fulfils every request by shelling out to `cursor-agent`.

```bash
# one-time
curl https://cursor.com/install -fsSL | bash    # install cursor-agent
cursor-agent login                              # auth with your Cursor account

# each session (or add to ~/.zshrc to auto-start)
bash tools/cursor-llm-proxy/start.sh
```

Then in the extension's options page set:

- **Provider**: `Custom`
- **Endpoint**: `http://127.0.0.1:8788/v1/chat/completions`
- **Model**: `sonnet-4`
- **API key**: (blank)

See [`tools/cursor-llm-proxy/README.md`](tools/cursor-llm-proxy/README.md) for details, launchd auto-start, performance caveats, and troubleshooting.

### Themes & stale tabs

- *Theme*: pick from Lavender / Ocean / Forest / Sunset.
- *Stale-tab detection*: enable, set N days; the dashboard tracks the last activated time of every tab in `chrome.storage.local`.

## Keyboard shortcuts

| Keys              | Action                                             |
| ----------------- | -------------------------------------------------- |
| `/`               | Focus the search box                               |
| `Cmd` / `Ctrl + K`| Open the command palette                           |
| `Cmd` / `Ctrl + click` | Toggle multi-select on a tab                  |
| `Esc`             | Clear selection / dismiss palette / modal          |
| `Enter` in search | Filter, or Google search if nothing matches        |

## Development

```
smart-new-tab/
├── manifest.json
├── newtab.html / options.html
├── background.js                  service worker (toolbar action)
├── styles/
│   ├── newtab.css
│   └── options.css
├── scripts/
│   ├── newtab.js                  dashboard view controller
│   ├── options.js                 settings UI
│   └── lib/
│       ├── tabs.js                fetch + normalize tabs
│       ├── categorize.js          heuristic grouping rules
│       ├── site-names.js          host → friendly site label map
│       ├── llm.js                 optional LLM client
│       ├── storage.js             chrome.storage.sync wrapper
│       ├── stats.js               impact metrics + sparklines + weekly report
│       ├── activity.js            per-tab last-active timestamps (stale detection)
│       ├── workspaces.js          named tab snapshots
│       ├── themes.js              theme palette definitions
│       └── command-palette.js     Cmd+K palette UI + dispatcher
├── icons/                         icon.svg + generated PNGs
└── tools/
    ├── generate-icons.sh          regenerate PNGs (macOS, no deps)
    └── cursor-llm-proxy/          OpenAI-compatible proxy → cursor-agent CLI
        ├── server.js              Node http server (no deps)
        ├── start.sh               launcher (resolves node, exports PATH)
        ├── install-launchd.sh     install / status / restart / uninstall
        ├── com.smartnewtab.cursorproxy.plist
        └── README.md
```

After editing any file, visit `chrome://extensions` and click the reload (↻) icon on the Smart New Tab card.

### Regenerate icons

```bash
./tools/generate-icons.sh
```

(Requires macOS — uses bundled `qlmanage` + `sips`. On Linux/Windows, edit the PNGs directly or open `icons/icon.svg` in any image editor and export.)

## Permissions used

| Permission   | Why                                                                       |
| ------------ | ------------------------------------------------------------------------- |
| `tabs`       | List, switch, close tabs across windows.                                  |
| `storage`    | Save settings, custom rules, impact stats, activity timestamps, workspaces. |
| `bookmarks`  | Bookmark a tab (single or bulk) from the dashboard.                       |
| `favicon`    | Render favicons via Chrome's built-in `_favicon/` endpoint.               |
| `sessions`   | Power the *Recently closed* row.                                          |

No content scripts are injected. The extension never reads the page content, never injects scripts into your tabs, and never makes any network request unless you explicitly enable AI grouping.

## License

MIT — see [LICENSE](LICENSE).
