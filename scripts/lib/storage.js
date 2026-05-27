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
  llm: {
    enabled: false,
    provider: 'openai', // 'openai' | 'anthropic' | 'ollama' | 'custom'
    endpoint: '',
    model: '',
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
