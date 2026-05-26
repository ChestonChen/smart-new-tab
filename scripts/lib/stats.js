/**
 * Persistent usage stats for the Impact panel.
 *
 * Stored under `chrome.storage.local.stats`:
 *   {
 *     firstUsed: 1748256000,                // unix seconds, set on first ever load
 *     lifetime:  { duplicates: 0, restored: 0, bulk: 0 },
 *     daily:     { 'YYYY-MM-DD': { duplicates, restored, bulk } }
 *   }
 *
 * Daily entries older than 60 days are pruned on every write so the
 * blob never grows unboundedly. 60 days is enough to compute "this
 * week" / "this month" panels without ever exceeding ~5 KB of storage.
 *
 * Event types (intentionally a small closed set):
 *   - 'duplicates'  — explicit "this was a redundant copy" close
 *                     (×N pill, merged-row × button, the dedupe sweep)
 *   - 'restored'    — chrome.sessions.restore success
 *   - 'bulk'        — N tabs closed via a single action other than
 *                     a regular per-tab × (Close all, group Close all,
 *                     multi-select Close)
 */

const KEY = 'stats';

const EVENT_TYPES = ['duplicates', 'restored', 'bulk'];

// Tuneable: how many seconds each event is estimated to save vs.
// doing the work by hand. Intentionally conservative — leader-safe.
const TIME_SAVED_SEC_PER_EVENT = {
  duplicates: 10, // skip the "is this a dup?" check + manual close
  restored: 25,   // recall URL / dig through Cmd+Shift+T menu
  bulk: 3,        // amortized per-tab when killing a batch
};

export function emptyStats() {
  return {
    firstUsed: Math.floor(Date.now() / 1000),
    lifetime: { duplicates: 0, restored: 0, bulk: 0 },
    daily: {},
  };
}

export async function loadStats() {
  const got = await chrome.storage.local.get(KEY);
  const stats = got[KEY];
  if (!stats || typeof stats !== 'object') {
    const seed = emptyStats();
    await chrome.storage.local.set({ [KEY]: seed });
    return seed;
  }
  // backfill any new fields if the schema ever evolves
  return {
    firstUsed: stats.firstUsed || Math.floor(Date.now() / 1000),
    lifetime: { duplicates: 0, restored: 0, bulk: 0, ...(stats.lifetime || {}) },
    daily: stats.daily || {},
  };
}

export async function resetStats() {
  await chrome.storage.local.set({ [KEY]: emptyStats() });
}

/**
 * Increment one of the EVENT_TYPES by `amount` (default 1).
 * Returns the post-update stats blob so the caller can re-render.
 */
export async function recordEvent(type, amount = 1) {
  if (!EVENT_TYPES.includes(type)) {
    console.warn('[stats] unknown event type:', type);
    return null;
  }
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const stats = await loadStats();
  stats.lifetime[type] = (stats.lifetime[type] || 0) + amount;

  const today = todayKey();
  if (!stats.daily[today]) stats.daily[today] = { duplicates: 0, restored: 0, bulk: 0 };
  stats.daily[today][type] = (stats.daily[today][type] || 0) + amount;

  pruneOldDailyEntries(stats);
  await chrome.storage.local.set({ [KEY]: stats });
  return stats;
}

/**
 * Mark today as an active day even if the user didn't trigger any
 * counted event — just opened the dashboard. Used to compute the
 * "N days active" metric without overcounting.
 */
export async function markActiveDay() {
  const stats = await loadStats();
  const today = todayKey();
  if (!stats.daily[today]) {
    stats.daily[today] = { duplicates: 0, restored: 0, bulk: 0 };
    pruneOldDailyEntries(stats);
    await chrome.storage.local.set({ [KEY]: stats });
  }
  return stats;
}

/**
 * Aggregate counts across the last `days` calendar days
 * (inclusive of today). Returns:
 *   { duplicates, restored, bulk, activeDays, timeSavedSec }
 */
export function summarizeRange(stats, days) {
  const cutoff = startOfDayMs(Date.now()) - (days - 1) * 86_400_000;
  let duplicates = 0;
  let restored = 0;
  let bulk = 0;
  let activeDays = 0;
  for (const [k, v] of Object.entries(stats.daily || {})) {
    const ms = new Date(k + 'T00:00:00').getTime();
    if (Number.isNaN(ms) || ms < cutoff) continue;
    duplicates += v.duplicates || 0;
    restored += v.restored || 0;
    bulk += v.bulk || 0;
    if ((v.duplicates || v.restored || v.bulk) > 0) activeDays += 1;
  }
  const timeSavedSec =
    duplicates * TIME_SAVED_SEC_PER_EVENT.duplicates +
    restored * TIME_SAVED_SEC_PER_EVENT.restored +
    bulk * TIME_SAVED_SEC_PER_EVENT.bulk;
  return { duplicates, restored, bulk, activeDays, timeSavedSec };
}

export function lifetimeSummary(stats) {
  const l = stats.lifetime || {};
  const duplicates = l.duplicates || 0;
  const restored = l.restored || 0;
  const bulk = l.bulk || 0;
  const timeSavedSec =
    duplicates * TIME_SAVED_SEC_PER_EVENT.duplicates +
    restored * TIME_SAVED_SEC_PER_EVENT.restored +
    bulk * TIME_SAVED_SEC_PER_EVENT.bulk;
  const activeDays = Object.values(stats.daily || {}).filter(
    (v) => (v.duplicates || v.restored || v.bulk) > 0,
  ).length;
  return { duplicates, restored, bulk, activeDays, timeSavedSec };
}

export function formatDuration(sec) {
  if (!sec || sec < 0) return '0 s';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const hours = sec / 3600;
  return hours < 10 ? `${hours.toFixed(1)} hr` : `${Math.round(hours)} hr`;
}

export const TIME_SAVED_BREAKDOWN = TIME_SAVED_SEC_PER_EVENT;

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function startOfDayMs(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function pruneOldDailyEntries(stats) {
  const cutoff = startOfDayMs(Date.now()) - 60 * 86_400_000;
  for (const k of Object.keys(stats.daily)) {
    const ms = new Date(k + 'T00:00:00').getTime();
    if (Number.isNaN(ms) || ms < cutoff) delete stats.daily[k];
  }
}
