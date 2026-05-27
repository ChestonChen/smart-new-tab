/**
 * Disk-backed AI override cache.
 *
 * Why URL-keyed and not tabId-keyed:
 *   Tab IDs are runtime-assigned and reset every Chrome restart. URLs (via
 *   the normalized dupeKey) survive restarts, tab close + reopen, and even
 *   "duplicate tab". That means once the LLM has labeled github.com/X, we
 *   never need to re-classify it — even if you close the tab and reopen it
 *   next week.
 *
 * Storage shape (chrome.storage.local, key 'aiOverridesByUrl'):
 *   {
 *     "<dupeKey>": { category: "Research", emoji: "🔬", savedAt: <ms> },
 *     ...
 *   }
 *
 * Sync vs local: we use local because (a) classification labels are not
 * portable across machines (different tabs, different work) and (b) sync
 * storage has a tight per-key quota that this cache would overshoot.
 */

const STORAGE_KEY = 'aiOverridesByUrl';

// Entries older than this are pruned on the next hydrate. Seven days is
// generous enough to keep weekend-only sites cached but short enough that
// a category we picked for a stale link last month doesn't follow you
// forever.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Hard ceiling on cache size; the oldest entries fall off first. Keeps
// chrome.storage.local from bloating if a power user racks up thousands
// of unique URLs.
const MAX_ENTRIES = 5000;

/**
 * Load the on-disk cache and prune expired entries (writing back if any
 * were removed). Returns a Map<dupeKey, {category, emoji, savedAt}>.
 */
export async function loadAICache() {
  const raw = await readRaw();
  const map = new Map();
  const now = Date.now();
  let dirty = false;

  for (const [url, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') {
      dirty = true;
      continue;
    }
    const savedAt = Number(entry.savedAt) || 0;
    if (now - savedAt > TTL_MS) {
      dirty = true;
      continue;
    }
    map.set(url, {
      category: String(entry.category || ''),
      emoji: entry.emoji ? String(entry.emoji) : '',
      savedAt,
    });
  }

  if (dirty) {
    // Best-effort cleanup; don't block hydration on storage write.
    writeRaw(mapToRaw(map)).catch(() => {});
  }
  return map;
}

/**
 * Merge `newEntries` (Map<dupeKey, {category, emoji}>) into the existing
 * on-disk cache and persist. Entries with the same key are overwritten
 * (newer LLM verdict wins). Enforces MAX_ENTRIES by dropping oldest.
 */
export async function mergeAICache(existing, newEntries) {
  const now = Date.now();
  for (const [url, v] of newEntries.entries()) {
    if (!url || !v || !v.category) continue;
    existing.set(url, {
      category: v.category,
      emoji: v.emoji || '',
      savedAt: now,
    });
  }

  if (existing.size > MAX_ENTRIES) {
    const sorted = [...existing.entries()].sort((a, b) => b[1].savedAt - a[1].savedAt);
    existing.clear();
    for (const [k, v] of sorted.slice(0, MAX_ENTRIES)) existing.set(k, v);
  }

  await writeRaw(mapToRaw(existing));
  return existing;
}

/**
 * Wipe the on-disk cache. Used when the user clicks the refresh button
 * or the AI chip to demand a fresh classification.
 */
export async function clearAICache() {
  await writeRaw({});
}

// ---------------------------------------------------------------------------

function readRaw() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      resolve(res?.[STORAGE_KEY] || {});
    });
  });
}

function writeRaw(obj) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: obj }, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function mapToRaw(map) {
  const out = {};
  for (const [k, v] of map.entries()) out[k] = v;
  return out;
}
