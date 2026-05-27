/**
 * Per-tab last-active timestamps for stale-tab detection.
 *
 * We can't know how long a tab has been "ignored" from chrome.tabs
 * alone — every freshly fetched tab looks the same. So the dashboard
 * subscribes to chrome.tabs.onActivated / onCreated, persists a map
 * of `tabId → unixSeconds` in chrome.storage.local, and prunes ids
 * that no longer exist on every dashboard load.
 *
 * Limitations (intentionally honest):
 *  - Tabs that existed BEFORE the extension was installed have no
 *    activity history and look "fresh" on first sight. We seed them
 *    with `now - 1 day` so they don't immediately scream "stale".
 *  - Tab ids reset on browser restart, so `lastActive` is best-effort,
 *    not a forensic log. Good enough for "did I touch this in a week?"
 */

const KEY = 'tabActivity';

/** Read the full map. Returns {} if nothing yet. */
export async function loadActivity() {
  const got = await chrome.storage.local.get(KEY);
  return got[KEY] || {};
}

async function saveActivity(map) {
  await chrome.storage.local.set({ [KEY]: map });
}

/** Stamp this tab id as just-touched. Fire-and-forget. */
export async function touchTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  const map = await loadActivity();
  map[tabId] = Math.floor(Date.now() / 1000);
  await saveActivity(map);
}

/**
 * Seed activity entries for tabs we don't have history for yet.
 * Brand-new tabs get "now"; previously-existing tabs without an entry
 * get a soft default (24 h ago) so they don't immediately register
 * as stale — that would be unfair on first install.
 */
export async function syncActivity(currentTabIds) {
  const map = await loadActivity();
  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - 86_400;
  const live = new Set(currentTabIds);
  let changed = false;

  for (const id of currentTabIds) {
    if (map[id] == null) {
      map[id] = oneDayAgo;
      changed = true;
    }
  }
  for (const id of Object.keys(map)) {
    if (!live.has(Number(id))) {
      delete map[id];
      changed = true;
    }
  }
  if (changed) await saveActivity(map);
  return map;
}

/**
 * Return the tab ids that haven't been activated for at least
 * `staleDays` days, given a freshly-synced activity map.
 */
export function findStaleTabIds(activityMap, tabs, staleDays) {
  const cutoff = Math.floor(Date.now() / 1000) - staleDays * 86_400;
  const stale = [];
  for (const t of tabs) {
    if (t.pinned) continue; // pinned tabs are never "stale"
    const last = activityMap[t.id];
    if (last != null && last < cutoff) stale.push(t.id);
  }
  return stale;
}

/** Wipe everything — used by options "Reset stats" if we want full reset. */
export async function resetActivity() {
  await chrome.storage.local.set({ [KEY]: {} });
}
