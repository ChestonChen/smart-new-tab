/**
 * Thin wrapper around chrome.storage.sync with sane defaults.
 */

export const DEFAULT_SETTINGS = {
  groupMode: 'category', // 'category' | 'domain' | 'window'
  showInternalPages: false,
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
