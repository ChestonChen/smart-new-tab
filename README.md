# Smart New Tab

Chrome extension that replaces the new tab page with a dashboard that **aggregates, groups, and de-duplicates all your open tabs across every window** — so you can actually find things when you have 50+ tabs open.

![preview placeholder](docs/preview.png)

## Features

- **One-glance overview.** All open tabs across every window, on a single page.
- **Smart grouping.** Domain-based + keyword-based heuristics out of the box (Development, Docs, Communication, Video, Shopping, Design, Cloud, …).
- **Duplicate detection.** Highlights tabs that point at the same logical page (utm params / fragments / trailing slash are normalized away). One-click "close duplicates" button.
- **Custom rules.** Map any host / URL / title substring to your own category & emoji.
- **AI grouping (optional).** Plug in OpenAI, Anthropic, local Ollama, or any OpenAI-compatible endpoint. Only `host` + `title` are sent — full URLs never leave your machine.
- **Search.** Fuzzy match across title, URL, host. Hit `/` from anywhere on the page to focus.
- **Switch / close / bookmark** any tab without leaving the dashboard.
- **No tracking, no analytics, no ads.** Local-first.

## Install (developer mode)

1. Clone or download this repo.
2. Open `chrome://extensions` in Chrome / Edge / Brave.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder.
5. Open a new tab.

To uninstall: same page → Remove.

## Configure

Click the extension toolbar icon, or hit **Settings** in the dashboard footer.

### Custom rules

In Settings → *Custom rules*:

| Match              | Category    | Emoji |
| ------------------ | ----------- | ----- |
| `notion.so`        | Notes       | 📝    |
| `figma.com`        | Design      | 🎨    |
| `meego.byted.org`  | Tickets     | 🎟️    |

Earlier rules win.

### AI grouping

In Settings → *AI grouping*, toggle on and fill the provider config:

| Provider | Endpoint (leave blank for default)        | Model example                | API key |
| -------- | ----------------------------------------- | ---------------------------- | ------- |
| OpenAI   | `https://api.openai.com/v1/chat/completions` | `gpt-4o-mini`             | required |
| Anthropic| `https://api.anthropic.com/v1/messages`   | `claude-3-5-haiku-latest`    | required |
| Ollama   | `http://localhost:11434/api/chat`         | `llama3.2` / `qwen2.5`       | not needed |
| Custom   | any OpenAI-compatible URL                 | depends                      | usually required |

**Privacy:** only the `host` and the trimmed `title` of each tab are transmitted. The full URL, query string, cookies, and page content are never sent.

## Development

```
smart-new-tab/
├── manifest.json
├── newtab.html / options.html
├── styles/                  CSS
├── scripts/
│   ├── newtab.js            dashboard view controller
│   ├── options.js           settings UI
│   └── lib/
│       ├── tabs.js          fetch + normalize tabs
│       ├── categorize.js    heuristic grouping rules
│       ├── llm.js           optional LLM client
│       └── storage.js       chrome.storage.sync wrapper
├── background.js            service worker (toolbar action)
├── icons/                   icon.svg + generated PNGs
└── tools/generate-icons.sh  regenerate PNGs (macOS, no deps)
```

After editing any file, visit `chrome://extensions` and click the reload (↻) icon on the Smart New Tab card.

### Regenerate icons

```bash
./tools/generate-icons.sh
```

(Requires macOS — uses bundled `qlmanage` + `sips`. If you're on Linux/Windows just edit the PNGs directly or open `icons/icon.svg` in any image editor and export.)

## Permissions used

| Permission   | Why                                                                 |
| ------------ | ------------------------------------------------------------------- |
| `tabs`       | List, switch, close tabs across windows.                            |
| `storage`    | Save your settings & custom rules.                                  |
| `bookmarks`  | Bookmark a tab from the dashboard.                                  |
| `favicon`    | Render favicons via Chrome's built-in `_favicon/` endpoint.         |

No content scripts are injected. The extension never reads the page content, never injects scripts into your tabs, and never makes any network request unless you explicitly enable AI grouping.

## License

MIT — see [LICENSE](LICENSE).
