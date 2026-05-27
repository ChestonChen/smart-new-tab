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
  const merged = deepMerge(DEFAULT_SETTINGS, data.settings || {});
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
