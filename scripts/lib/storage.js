/**
 * Thin wrapper around chrome.storage.sync with sane defaults.
 */

export const DEFAULT_SETTINGS = {
  groupMode: 'domain', // 'domain' | 'category' | 'window'
  showInternalPages: false,
  // Visual theme; controls the mesh gradient + brand accent palette.
  theme: 'lavender', // 'lavender' | 'ocean' | 'forest' | 'sunset'
  // Stale-tab detection: prompt the user when N tabs go unused for
  // more than `staleDays` days. Disabled = no callout / no badges.
  staleEnabled: true,
  staleDays: 7,
  // Bookmarks bar strip below the hero. Toggled by the bookmark icon
  // in the topbar; default ON because users who go looking for it want
  // it visible by default.
  bookmarksBarVisible: true,
  // AI grouping is hardcoded to talk to the bundled cursor-llm-proxy.
  // The user can't change these from the options page; if the local
  // proxy isn't running, llm.js silently falls back to heuristic groups.
  // See tools/cursor-llm-proxy/ for how to start the proxy.
  llm: {
    enabled: true,
    provider: 'custom',
    endpoint: 'http://127.0.0.1:8788/v1/chat/completions',
    model: 'sonnet-4',
    apiKey: '',
  },
  userRules: [
    // example shape: { match: 'notion.so', category: 'Notes', emoji: '📝' }
  ],
};

export async function loadSettings() {
  const data = await chrome.storage.sync.get('settings');
  let merged = deepMerge(DEFAULT_SETTINGS, data.settings || {});

  // One-shot migration. AI grouping is no longer user-configurable;
  // older builds may have persisted provider:'openai' + a stale endpoint.
  // If the stored llm block doesn't match the pinned defaults, overwrite
  // it (and discard any leftover apiKey) so the dashboard talks to
  // cursor-llm-proxy on the next call.
  const stored = merged.llm || {};
  const expected = DEFAULT_SETTINGS.llm;
  const drifted =
    stored.provider !== expected.provider ||
    stored.endpoint !== expected.endpoint ||
    stored.enabled !== expected.enabled ||
    !!stored.apiKey;
  if (drifted) {
    merged = { ...merged, llm: { ...expected } };
    try { await saveSettings(merged); } catch { /* best-effort */ }
  }
  return merged;
}

export async function saveSettings(next) {
  await chrome.storage.sync.set({ settings: next });
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch && typeof patch === 'object') {
    const out = { ...base };
    for (const k of Object.keys(patch)) {
      out[k] = deepMerge(base?.[k], patch[k]);
    }
    return out;
  }
  return patch === undefined ? base : patch;
}
