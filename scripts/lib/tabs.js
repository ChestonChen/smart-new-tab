/**
 * Fetch open tabs across all (normal) windows and normalize them
 * into a stable shape for the rest of the app.
 */

const INTERNAL_SCHEMES = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'devtools:'];

export function isInternalUrl(url = '') {
  return INTERNAL_SCHEMES.some((s) => url.startsWith(s));
}

export function parseHost(url = '') {
  try {
    const u = new URL(url);
    return {
      host: u.hostname || '',
      origin: u.origin || '',
      path: u.pathname || '/',
      // eTLD+1 approximation — good enough for grouping without a PSL.
      rootDomain: deriveRootDomain(u.hostname || ''),
    };
  } catch {
    return { host: '', origin: '', path: '', rootDomain: '' };
  }
}

function deriveRootDomain(host) {
  if (!host || /^[\d.:]+$/.test(host)) return host;
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  // Handle common 2-level public suffixes (e.g. .co.uk, .com.cn).
  const last2 = parts.slice(-2).join('.');
  const twoLevelSuffix = new Set([
    'co.uk', 'co.jp', 'co.kr', 'com.cn', 'com.hk', 'com.tw',
    'com.au', 'com.br', 'com.sg', 'org.uk', 'gov.uk', 'ac.uk',
  ]);
  if (twoLevelSuffix.has(last2) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return last2;
}

/**
 * @returns {Promise<Array<NormalizedTab>>}
 * @typedef {Object} NormalizedTab
 * @property {number} id
 * @property {number} windowId
 * @property {string} title
 * @property {string} url
 * @property {string} favIconUrl
 * @property {boolean} pinned
 * @property {boolean} audible
 * @property {string} host
 * @property {string} origin
 * @property {string} rootDomain
 * @property {string} path
 * @property {string} dupeKey   // normalized URL used to detect duplicates
 */
export async function fetchAllTabs({ includeInternal = false } = {}) {
  const raw = await chrome.tabs.query({ windowType: 'normal' });
  const out = [];
  for (const t of raw) {
    if (!t.url) continue;
    if (!includeInternal && isInternalUrl(t.url)) continue;
    const { host, origin, path, rootDomain } = parseHost(t.url);
    out.push({
      id: t.id,
      windowId: t.windowId,
      title: t.title || host || t.url,
      url: t.url,
      favIconUrl: t.favIconUrl || '',
      pinned: !!t.pinned,
      audible: !!t.audible,
      host,
      origin,
      rootDomain,
      path,
      dupeKey: normalizeUrlForDupe(t.url),
    });
  }
  return out;
}

/**
 * Strip noise (utm params, fragment, trailing slash) so visits to the
 * same logical page count as duplicates.
 */
export function normalizeUrlForDupe(url) {
  try {
    const u = new URL(url);
    const trashParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'fbclid', 'ref', 'ref_src', 'ref_url', 'spm', 'from',
    ];
    for (const p of trashParams) u.searchParams.delete(p);
    u.hash = '';
    let pathname = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.origin}${pathname}${u.searchParams.toString() ? '?' + u.searchParams.toString() : ''}`;
  } catch {
    return url;
  }
}

/**
 * Index tabs by dupeKey. Returns a Map<dupeKey, NormalizedTab[]>.
 */
export function indexByDupeKey(tabs) {
  const m = new Map();
  for (const t of tabs) {
    const arr = m.get(t.dupeKey);
    if (arr) arr.push(t);
    else m.set(t.dupeKey, [t]);
  }
  return m;
}

/**
 * Collapse tabs that point at the same logical URL into a single
 * "merged tab" so the dashboard displays one row per unique URL.
 * The returned object carries the full list of underlying tab ids
 * sorted so that the representative (the one we keep until last)
 * comes first.
 *
 * Representative selection: pinned tabs win, then smallest id (=
 * oldest, since Chrome ids are monotonic per session). That way we
 * keep the user's "original" tab and close the redundant clones.
 *
 * @returns {Array<MergedTab>}
 * @typedef {NormalizedTab & {
 *   _dupeIds: number[],   // every underlying tab id, rep first
 *   _dupeCount: number,   // shortcut for _dupeIds.length
 * }} MergedTab
 */
export function mergeDuplicates(tabs) {
  const byKey = indexByDupeKey(tabs);
  const merged = [];
  for (const arr of byKey.values()) {
    const sorted = [...arr].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.id - b.id;
    });
    const rep = sorted[0];
    merged.push({
      ...rep,
      _dupeIds: sorted.map((t) => t.id),
      _dupeCount: sorted.length,
    });
  }
  return merged;
}

/**
 * Resolve a favicon URL we can actually display.
 * - If tab gave us one, use it.
 * - Otherwise hit the `_favicon` permission endpoint (works for any URL,
 *   bundled by Chrome, no network).
 */
export function resolveFavicon(tab) {
  if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
    return tab.favIconUrl;
  }
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', tab.url);
  u.searchParams.set('size', '32');
  return u.toString();
}
