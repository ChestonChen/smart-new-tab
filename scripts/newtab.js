import { fetchAllTabs, indexByDupeKey, mergeDuplicates, resolveFavicon } from './lib/tabs.js';
import {
  categorizeHeuristic,
  applyLLMOverrides,
} from './lib/categorize.js';
import { siteNameFor } from './lib/site-names.js';
import { loadSettings, saveSettings } from './lib/storage.js';
import { classifyTabsWithLLM } from './lib/llm.js';
import {
  loadStats,
  markActiveDay,
  recordEvent,
  summarizeRange,
  lifetimeSummary,
  formatDuration,
} from './lib/stats.js';

const els = {
  greeting: document.getElementById('greeting'),
  heroDate: document.getElementById('hero-date'),

  search: document.getElementById('search-input'),
  google: document.getElementById('google-btn'),
  refresh: document.getElementById('refresh-btn'),
  settings: document.getElementById('settings-btn'),

  groupMode: document.getElementById('group-mode'),
  summaryStat: document.getElementById('summary-stat'),
  dedupeBtn: document.getElementById('dedupe-btn'),
  dedupeCount: document.getElementById('dedupe-count'),
  closeAllBtn: document.getElementById('close-all-btn'),
  totalTabCount: document.getElementById('total-tab-count'),

  board: document.getElementById('board'),
  emptyState: document.getElementById('empty-state'),

  // Recently closed
  recentlyClosed: document.getElementById('recently-closed'),
  recentlyClosedList: document.getElementById('recently-closed-list'),

  // Bulk action bar
  actionBar: document.getElementById('action-bar'),
  actionBarCount: document.getElementById('ab-count-num'),
  abClose: document.getElementById('ab-close'),
  abBookmark: document.getElementById('ab-bookmark'),
  abCancel: document.getElementById('ab-cancel'),

  // Search empty state
  searchEmpty: document.getElementById('search-empty'),
  searchEmptyQuery: document.getElementById('search-empty-query'),
  searchEmptyQuery2: document.getElementById('search-empty-query-2'),
  searchGoogleBtn: document.getElementById('search-google-btn'),

  // Impact panel
  impactMeta: document.getElementById('impact-meta'),
  impactDupWeek: document.getElementById('impact-dup-week'),
  impactDupLife: document.getElementById('impact-dup-life'),
  impactResWeek: document.getElementById('impact-res-week'),
  impactResLife: document.getElementById('impact-res-life'),
  impactBulkWeek: document.getElementById('impact-bulk-week'),
  impactBulkLife: document.getElementById('impact-bulk-life'),
  impactTimeWeek: document.getElementById('impact-time-week'),

  aiStatusValue: document.getElementById('ai-status-value'),
  openOptions: document.getElementById('open-options'),
};

const tpl = {
  group: document.getElementById('group-template'),
  tab: document.getElementById('tab-template'),
};

const state = {
  tabs: [],
  settings: null,
  query: '',
  groups: new Map(),
  dupeIndex: new Map(),
  // Multi-select: stores merged-row ids (== representative tab.id).
  // Closing a selected row will tear down ALL of that row's _dupeIds.
  selection: new Set(),
};

// ---------------------------------------------------------------------------

init().catch((err) => {
  console.error(err);
  toast('Failed to load tabs: ' + err.message);
});

async function init() {
  state.settings = await loadSettings();
  els.groupMode.value = state.settings.groupMode || 'domain';
  renderHero();
  updateAIStatusBadge();
  bindEvents();

  // Stamp today as an active day so we can compute the "X days
  // active" metric honestly. Fire-and-forget — never block UI on it.
  markActiveDay().then(renderImpact).catch(() => {});

  await reload();
  registerTabListeners();
}

function bindEvents() {
  els.search.addEventListener('input', (e) => {
    state.query = e.target.value.trim().toLowerCase();
    render();
  });
  // Enter inside the search box: activate the first visible match,
  // or — when nothing matches — fall back to a Google search.
  els.search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (!state.query) return;
    const first = findFirstVisibleTab();
    if (first) {
      activateTab(first);
    } else {
      searchOnGoogle(state.query, e.shiftKey || e.metaKey || e.ctrlKey);
    }
  });

  els.refresh.addEventListener('click', () => reload());
  els.settings.addEventListener('click', openOptions);
  els.google.addEventListener('click', (e) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      window.open('https://www.google.com/', '_blank', 'noopener');
    } else {
      window.location.href = 'https://www.google.com/';
    }
  });
  els.openOptions.addEventListener('click', (e) => { e.preventDefault(); openOptions(); });

  els.groupMode.addEventListener('change', async () => {
    state.settings.groupMode = els.groupMode.value;
    await saveSettings(state.settings);
    clearSelection();
    await reload();
  });

  els.dedupeBtn.addEventListener('click', closeDuplicates);
  els.closeAllBtn.addEventListener('click', closeEverything);

  // Bulk-action bar
  els.abClose.addEventListener('click', bulkCloseSelected);
  els.abBookmark.addEventListener('click', bulkBookmarkSelected);
  els.abCancel.addEventListener('click', clearSelection);

  // Google fallback when search returns nothing
  els.searchGoogleBtn.addEventListener('click', (e) => {
    searchOnGoogle(state.query, e.shiftKey || e.metaKey || e.ctrlKey);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== els.search) {
      e.preventDefault();
      els.search.focus();
      return;
    }
    if (e.key === 'Escape') {
      if (state.selection.size > 0) {
        clearSelection();
        e.preventDefault();
      } else if (state.query && document.activeElement === els.search) {
        els.search.value = '';
        state.query = '';
        render();
      }
    }
  });
}

function registerTabListeners() {
  const debounced = debounce(reload, 300);
  chrome.tabs.onCreated.addListener(debounced);
  chrome.tabs.onRemoved.addListener(debounced);
  chrome.tabs.onUpdated.addListener((_, info) => {
    if (info.url || info.title || info.favIconUrl) debounced();
  });
  chrome.tabs.onMoved.addListener(debounced);
  chrome.tabs.onAttached.addListener(debounced);
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function renderHero() {
  const now = new Date();
  const h = now.getHours();
  let g;
  if (h < 5) g = 'Good night';
  else if (h < 12) g = 'Good morning';
  else if (h < 18) g = 'Good afternoon';
  else if (h < 22) g = 'Good evening';
  else g = 'Good night';
  els.greeting.textContent = g;

  const fmt = new Intl.DateTimeFormat(navigator.language || 'en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  els.heroDate.textContent = fmt.format(now);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function reload() {
  const tabs = await fetchAllTabs({
    includeInternal: state.settings.showInternalPages,
  });
  state.tabs = tabs;
  state.dupeIndex = indexByDupeKey(tabs);

  // In "by window" mode we want the user to see each window's
  // contents verbatim, so we skip de-duplication there. In all
  // other modes we collapse same-URL tabs into a single row that
  // carries the full id list — clicking × closes one at a time.
  const mode = state.settings.groupMode || 'domain';
  const tabsForGroups = mode === 'window' ? tabs : mergeDuplicates(tabs);
  state.groups = await buildGroups(tabsForGroups);

  // Prune selection: drop ids that no longer exist (just closed).
  if (state.selection.size > 0) {
    const liveRowIds = new Set();
    for (const g of state.groups.values()) {
      for (const t of g.items) liveRowIds.add(t.id);
    }
    for (const id of state.selection) {
      if (!liveRowIds.has(id)) state.selection.delete(id);
    }
  }

  updateSummary();
  render();
  // Recently-closed and Impact are independent of the tab list;
  // refresh both in parallel without blocking dashboard render.
  refreshRecentlyClosed();
  renderImpact();
}

async function buildGroups(tabs) {
  const mode = state.settings.groupMode || 'domain';
  if (mode === 'domain') return groupByDomain(tabs);
  if (mode === 'window') return groupByWindow(tabs);

  // category mode
  const heuristic = categorizeHeuristic(tabs, {
    userRules: state.settings.userRules,
  });
  if (!state.settings.llm?.enabled) return heuristic;

  classifyTabsWithLLM(tabs, state.settings.llm).then((overrides) => {
    if (!overrides || overrides.size === 0) return;
    const merged = applyLLMOverrides(heuristic, tabs, overrides);
    state.groups = merged;
    render();
    toast('AI grouping applied');
  });

  return heuristic;
}

/**
 * Domain grouping: tabs on the same site share a group; group label
 * is the human-friendly site name (YouTube, Lark Docs, …).
 */
function groupByDomain(tabs) {
  const groups = new Map();
  for (const t of tabs) {
    const label = siteNameFor(t);
    const id = 'site:' + label;
    if (!groups.has(id)) {
      groups.set(id, { info: { id, label, emoji: '' }, items: [] });
    }
    groups.get(id).items.push(t);
  }
  return new Map(
    [...groups.entries()].sort(([, a], [, b]) => b.items.length - a.items.length),
  );
}

function groupByWindow(tabs) {
  const groups = new Map();
  for (const t of tabs) {
    const id = 'win:' + t.windowId;
    const info = { id, label: `Window ${t.windowId}`, emoji: '' };
    if (!groups.has(id)) groups.set(id, { info, items: [] });
    groups.get(id).items.push(t);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Summary header
// ---------------------------------------------------------------------------

function updateSummary() {
  const tabs = state.tabs;
  const groupCount = state.groups.size;
  const windowCount = new Set(tabs.map((t) => t.windowId)).size;

  let dupes = 0;
  for (const arr of state.dupeIndex.values()) if (arr.length > 1) dupes += arr.length - 1;

  const mode = state.settings.groupMode || 'domain';
  const groupNoun = mode === 'domain' ? plural(groupCount, 'site', 'sites')
                  : mode === 'window' ? plural(windowCount, 'window', 'windows')
                  : plural(groupCount, 'category', 'categories');

  els.summaryStat.textContent =
    `${groupCount} ${groupNoun}` +
    (windowCount > 1 ? ` · ${windowCount} windows` : '');

  if (dupes > 0) {
    els.dedupeBtn.hidden = false;
    els.dedupeCount.textContent = dupes;
  } else {
    els.dedupeBtn.hidden = true;
  }

  els.totalTabCount.textContent = tabs.length;
  els.closeAllBtn.disabled = tabs.length === 0;
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  els.board.innerHTML = '';
  const q = state.query;
  const matchedGroups = [];

  for (const { info, items } of state.groups.values()) {
    const visible = q ? items.filter((t) => matchTab(t, q)) : items;
    if (visible.length > 0) matchedGroups.push({ info, items: visible });
  }

  if (matchedGroups.length === 0) {
    if (q) {
      els.searchEmptyQuery.textContent = q;
      els.searchEmptyQuery2.textContent = q;
      const empty = els.searchEmpty.cloneNode(true);
      empty.hidden = false;
      // Cloned button needs its own click handler; the original
      // button's listener was bound at startup but that element is
      // now detached.
      empty.querySelector('#search-google-btn').addEventListener('click', (e) => {
        searchOnGoogle(q, e.shiftKey || e.metaKey || e.ctrlKey);
      });
      els.board.appendChild(empty);
    } else {
      const empty = els.emptyState.cloneNode(true);
      empty.hidden = false;
      els.board.appendChild(empty);
    }
  } else {
    for (const g of matchedGroups) els.board.appendChild(renderGroup(g));
  }
  // Always re-sync selection — handles search filters too, where a
  // selected tab might be hidden but the action bar should stay up.
  applySelectionToDOM();
}

function matchTab(t, q) {
  return (
    t.title.toLowerCase().includes(q) ||
    t.url.toLowerCase().includes(q) ||
    t.host.toLowerCase().includes(q)
  );
}

function renderGroup({ info, items }) {
  const node = tpl.group.content.firstElementChild.cloneNode(true);
  node.dataset.groupId = info.id;
  node.querySelector('.group-name').textContent = info.label;

  const count = items.length;
  node.querySelector('.group-count').textContent = count;
  node.querySelector('.group-count-label').textContent =
    count === 1 ? ' tab open' : ' tabs open';

  const list = node.querySelector('.tab-list');
  for (const t of items) list.appendChild(renderTab(t));

  // For the bottom "Close all N tabs" button: N counts every
  // underlying tab (including dupes inside merged rows), so the
  // label matches the real number of tabs that will disappear.
  const allIds = items.flatMap((t) => t._dupeIds || [t.id]).filter(Number.isInteger);
  const closeBtn = node.querySelector('.group-close-all');
  closeBtn.querySelector('.group-close-label').textContent =
    `Close all ${allIds.length} ${allIds.length === 1 ? 'tab' : 'tabs'}`;
  closeBtn.addEventListener('click', async () => {
    if (allIds.length > 1 && !confirm(`Close all ${allIds.length} tabs in "${info.label}"?`)) return;
    await chrome.tabs.remove(allIds);
    // Bulk-style action when more than one tab is killed in a click.
    if (allIds.length > 1) recordEvent('bulk', allIds.length).then(renderImpact);
    await reload();
    toast(`Closed ${allIds.length} tab${allIds.length === 1 ? '' : 's'}`);
  });

  return node;
}

function renderTab(t) {
  const node = tpl.tab.content.firstElementChild.cloneNode(true);
  node.dataset.tabId = t.id;

  node.querySelector('.tab-favicon').src = resolveFavicon(t);
  node.querySelector('.tab-title').textContent = t.title || t.url;
  node.title = `${t.title || ''}\n${t.url}`;

  // How many real tabs does this row represent?
  // In merged modes (`by site` / `by category`), a row can stand
  // for N duplicates and _dupeCount > 1.
  // In window mode (no merging), we still show a badge when the
  // same URL exists in another window, but the row itself is
  // exactly one tab.
  const dupeCount = t._dupeCount || (state.dupeIndex.get(t.dupeKey)?.length || 1);
  if (dupeCount > 1) {
    node.classList.add('duplicate');
    const dupe = node.querySelector('.tab-dupe');
    node.querySelector('.tab-dupe-count').textContent = dupeCount;
    dupe.hidden = false;
  }

  node.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    // Cmd/Ctrl-click → toggle selection; plain click → activate.
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      toggleSelection(t.id);
      return;
    }
    activateTab(t);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) toggleSelection(t.id);
      else activateTab(t);
    }
  });

  const closeBtn = node.querySelector('.tab-close');
  closeBtn.title = dupeCount > 1
    ? `Close 1 of ${dupeCount} (${dupeCount - 1} will remain)`
    : 'Close tab';
  closeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const idToClose = pickIdToClose(t);
    await chrome.tabs.remove(idToClose);
    // If this row was merged (dupeCount > 1) and the user clicked ×,
    // they consciously chose to drop a duplicate — count it.
    if (dupeCount > 1) {
      recordEvent('duplicates', 1).then(renderImpact);
      const badge = node.querySelector('.tab-dupe-count');
      if (badge) badge.textContent = dupeCount - 1;
      closeBtn.title = dupeCount - 1 > 1
        ? `Close 1 of ${dupeCount - 1} (${dupeCount - 2} will remain)`
        : 'Close tab';
      setTimeout(reload, 100);
    } else {
      node.style.transition = 'opacity .15s';
      node.style.opacity = '0';
      setTimeout(reload, 150);
    }
  });

  node.querySelector('.tab-bookmark').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await chrome.bookmarks.create({ title: t.title, url: t.url });
      toast('Bookmarked');
    } catch (err) {
      toast('Bookmark failed: ' + err.message);
    }
  });

  return node;
}

/**
 * Decide which underlying tab id to actually close when the user
 * clicks × on a row that represents multiple duplicates.
 *
 * Strategy: keep the representative (the rep is at index 0 of
 * _dupeIds because mergeDuplicates sorts it there) until last,
 * and remove the most recently opened duplicate first. That way
 * the user can repeatedly click × to peel off clones, and the
 * tab they originally opened survives.
 */
function pickIdToClose(t) {
  const ids = t._dupeIds && t._dupeIds.length ? t._dupeIds : [t.id];
  if (ids.length === 1) return ids[0];
  const repId = ids[0];
  // Prefer non-rep ids, highest first (= newest dup).
  const others = ids.slice(1);
  return others.length > 0 ? Math.max(...others) : repId;
}

async function activateTab(t) {
  try {
    await chrome.tabs.update(t.id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  } catch (err) {
    toast('Could not switch: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------

async function closeDuplicates() {
  const toClose = [];
  for (const arr of state.dupeIndex.values()) {
    if (arr.length <= 1) continue;
    const sorted = [...arr].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.id - b.id;
    });
    for (let i = 1; i < sorted.length; i++) toClose.push(sorted[i].id);
  }
  if (toClose.length === 0) {
    toast('No duplicates to close 🎉');
    return;
  }
  if (!confirm(`Close ${toClose.length} duplicate tab${toClose.length === 1 ? '' : 's'}?`)) return;
  await chrome.tabs.remove(toClose);
  recordEvent('duplicates', toClose.length).then(renderImpact);
  await reload();
  toast(`Closed ${toClose.length} duplicate${toClose.length === 1 ? '' : 's'}`);
}

async function closeEverything() {
  const ids = state.tabs.map((t) => t.id).filter((id) => Number.isInteger(id));
  if (ids.length === 0) return;
  if (!confirm(`Close all ${ids.length} open tabs across every window?`)) return;
  await chrome.tabs.remove(ids);
  recordEvent('bulk', ids.length).then(renderImpact);
  await reload();
  toast(`Closed ${ids.length} tabs`);
}

// ---------------------------------------------------------------------------
// Impact panel
// ---------------------------------------------------------------------------

async function renderImpact() {
  let stats;
  try {
    stats = await loadStats();
  } catch (err) {
    console.warn('[smart-new-tab] loadStats failed:', err);
    return;
  }
  const week = summarizeRange(stats, 7);
  const life = lifetimeSummary(stats);

  if (els.impactDupWeek)  els.impactDupWeek.textContent  = week.duplicates;
  if (els.impactResWeek)  els.impactResWeek.textContent  = week.restored;
  if (els.impactBulkWeek) els.impactBulkWeek.textContent = week.bulk;
  if (els.impactTimeWeek) els.impactTimeWeek.textContent = formatDuration(week.timeSavedSec);

  if (els.impactDupLife)  els.impactDupLife.textContent  = life.duplicates;
  if (els.impactResLife)  els.impactResLife.textContent  = life.restored;
  if (els.impactBulkLife) els.impactBulkLife.textContent = life.bulk;

  if (els.impactMeta) {
    const firstUsedMs = (stats.firstUsed || 0) * 1000;
    const days = Math.max(1, Math.floor((Date.now() - firstUsedMs) / 86_400_000) + 1);
    const fmt = new Intl.DateTimeFormat(navigator.language || 'en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    els.impactMeta.textContent =
      `Since ${fmt.format(new Date(firstUsedMs))} · ${days} day${days === 1 ? '' : 's'} · ${life.activeDays} active`;
  }
}

// ---------------------------------------------------------------------------
// Recently closed
// ---------------------------------------------------------------------------

async function refreshRecentlyClosed() {
  if (!chrome.sessions || !chrome.sessions.getRecentlyClosed) {
    els.recentlyClosed.hidden = true;
    return;
  }
  let sessions;
  try {
    sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 12 });
  } catch (err) {
    console.warn('[smart-new-tab] sessions API failed:', err);
    els.recentlyClosed.hidden = true;
    return;
  }
  const items = [];
  for (const s of sessions) {
    if (s.tab) {
      items.push({
        kind: 'tab',
        sessionId: s.tab.sessionId,
        title: s.tab.title || s.tab.url,
        url: s.tab.url,
        favIconUrl: s.tab.favIconUrl,
        lastModified: s.lastModified,
      });
    } else if (s.window) {
      const w = s.window;
      const tabsArr = w.tabs || [];
      const heads = tabsArr.slice(0, 3).map((t) => t.title).filter(Boolean);
      items.push({
        kind: 'window',
        sessionId: w.sessionId,
        tabCount: tabsArr.length,
        title: `Window · ${tabsArr.length} tab${tabsArr.length === 1 ? '' : 's'}`,
        subtitle: heads.join(' · '),
        favIconUrl: tabsArr[0]?.favIconUrl,
        url: tabsArr[0]?.url,
        lastModified: s.lastModified,
      });
    }
  }
  renderRecentlyClosed(items);
}

function renderRecentlyClosed(items) {
  if (items.length === 0) {
    els.recentlyClosed.hidden = true;
    return;
  }
  els.recentlyClosed.hidden = false;
  els.recentlyClosedList.innerHTML = '';

  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'rc-item';
    li.title = it.url || it.subtitle || it.title;

    const fav = document.createElement('img');
    fav.className = 'rc-favicon';
    fav.alt = '';
    fav.loading = 'lazy';
    if (it.kind === 'window') {
      // Stack-of-tabs glyph for restored-window entries.
      fav.src =
        'data:image/svg+xml;utf8,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
            '<rect x="1.5" y="2.5" width="11" height="8" rx="1.5" fill="none" stroke="%238a8780" stroke-width="1.2"/>' +
            '<rect x="3.5" y="4.5" width="11" height="8" rx="1.5" fill="%23ffffff" stroke="%238a8780" stroke-width="1.2"/>' +
          '</svg>',
        );
    } else if (it.favIconUrl) {
      fav.src = it.favIconUrl;
    } else if (it.url) {
      const u = new URL(chrome.runtime.getURL('/_favicon/'));
      u.searchParams.set('pageUrl', it.url);
      u.searchParams.set('size', '32');
      fav.src = u.toString();
    }
    li.appendChild(fav);

    const text = document.createElement('div');
    text.className = 'rc-text';
    const name = document.createElement('div');
    name.className = 'rc-name';
    name.textContent = it.title;
    const meta = document.createElement('div');
    meta.className = 'rc-meta';
    meta.textContent = it.subtitle
      ? `${it.subtitle} · ${relativeTime(it.lastModified)}`
      : relativeTime(it.lastModified);
    text.appendChild(name);
    text.appendChild(meta);
    li.appendChild(text);

    const restore = document.createElement('span');
    restore.className = 'rc-restore';
    restore.textContent = '↺';
    li.appendChild(restore);

    li.addEventListener('click', async () => {
      try {
        await chrome.sessions.restore(it.sessionId);
        // A window restore brings back N tabs at once; count each.
        const amount = it.kind === 'window' ? Math.max(1, Number(it.tabCount) || 1) : 1;
        recordEvent('restored', amount).then(renderImpact);
        await reload();
      } catch (err) {
        toast('Could not restore: ' + err.message);
      }
    });

    els.recentlyClosedList.appendChild(li);
  }
}

function relativeTime(unixSeconds) {
  if (!unixSeconds) return '';
  const diff = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Multi-select
// ---------------------------------------------------------------------------

function rowIdToMergedTab(rowId) {
  for (const g of state.groups.values()) {
    for (const t of g.items) if (t.id === rowId) return t;
  }
  return null;
}

function toggleSelection(rowId) {
  if (state.selection.has(rowId)) state.selection.delete(rowId);
  else state.selection.add(rowId);
  applySelectionToDOM();
}

function clearSelection() {
  state.selection.clear();
  applySelectionToDOM();
}

function applySelectionToDOM() {
  for (const node of els.board.querySelectorAll('.tab')) {
    const id = Number(node.dataset.tabId);
    node.classList.toggle('selected', state.selection.has(id));
  }
  if (state.selection.size === 0) {
    els.actionBar.hidden = true;
    return;
  }
  // Count REAL underlying tabs (handles dupes inside merged rows).
  let n = 0;
  for (const rowId of state.selection) {
    const t = rowIdToMergedTab(rowId);
    if (!t) continue;
    n += (t._dupeIds || [t.id]).length;
  }
  els.actionBarCount.textContent = n;
  els.actionBar.hidden = false;
}

async function bulkCloseSelected() {
  if (state.selection.size === 0) return;
  const ids = [];
  for (const rowId of state.selection) {
    const t = rowIdToMergedTab(rowId);
    if (t) ids.push(...(t._dupeIds || [t.id]));
  }
  if (ids.length === 0) return;
  if (!confirm(`Close ${ids.length} selected tab${ids.length === 1 ? '' : 's'}?`)) return;
  await chrome.tabs.remove(ids);
  recordEvent('bulk', ids.length).then(renderImpact);
  state.selection.clear();
  await reload();
  toast(`Closed ${ids.length} tab${ids.length === 1 ? '' : 's'}`);
}

async function bulkBookmarkSelected() {
  if (state.selection.size === 0) return;
  let ok = 0;
  for (const rowId of state.selection) {
    const t = rowIdToMergedTab(rowId);
    if (!t) continue;
    try {
      await chrome.bookmarks.create({ title: t.title, url: t.url });
      ok++;
    } catch {
      // ignore individual failures; keep going so the rest succeed
    }
  }
  clearSelection();
  toast(`Bookmarked ${ok}`);
}

// ---------------------------------------------------------------------------
// Search → Google fallback
// ---------------------------------------------------------------------------

function searchOnGoogle(query, openInNewTab = false) {
  if (!query) return;
  const url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
  if (openInNewTab) window.open(url, '_blank', 'noopener');
  else window.location.href = url;
}

function findFirstVisibleTab() {
  const q = state.query;
  if (!q) return null;
  for (const g of state.groups.values()) {
    for (const t of g.items) if (matchTab(t, q)) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function updateAIStatusBadge() {
  const enabled = !!state.settings?.llm?.enabled;
  els.aiStatusValue.textContent = enabled ? 'on' : 'off';
  els.aiStatusValue.style.color = enabled ? '#0ea5e9' : 'var(--text-mute)';
}

function openOptions() {
  chrome.runtime.openOptionsPage();
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

let toastHost;
function toast(msg) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
