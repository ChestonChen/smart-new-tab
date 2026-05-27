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
  dailySeries,
  shouldShowWeeklyReport,
  markWeeklyReportShown,
} from './lib/stats.js';
import {
  touchTab,
  syncActivity,
  findStaleTabIds,
} from './lib/activity.js';
import {
  listWorkspaces,
  createWorkspace,
  deleteWorkspace,
  renameWorkspace,
  restoreWorkspace,
} from './lib/workspaces.js';
import { applyTheme } from './lib/themes.js';
import { createCommandPalette } from './lib/command-palette.js';
import {
  loadAICache,
  mergeAICache,
  clearAICache as clearAICacheDisk,
} from './lib/ai-cache.js';

const els = {
  greeting: document.getElementById('greeting'),
  heroDate: document.getElementById('hero-date'),

  search: document.getElementById('search-input'),
  google: document.getElementById('google-btn'),
  refresh: document.getElementById('refresh-btn'),
  settings: document.getElementById('settings-btn'),

  groupMode: document.getElementById('group-mode'),
  aiChip: document.getElementById('ai-chip'),
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
  sparkDup: document.getElementById('spark-dup'),
  sparkRes: document.getElementById('spark-res'),
  sparkBulk: document.getElementById('spark-bulk'),

  // Pinned tabs
  pinnedSection: document.getElementById('pinned-section'),
  pinnedRow: document.getElementById('pinned-row'),

  // Workspaces
  wsRow: document.getElementById('ws-row'),
  wsNew: document.getElementById('ws-new'),

  // Stale banner
  staleBanner: document.getElementById('stale-banner'),
  staleCount: document.getElementById('stale-count'),
  staleDays: document.getElementById('stale-days'),
  staleReview: document.getElementById('stale-review'),
  staleClose: document.getElementById('stale-close'),
  staleDismiss: document.getElementById('stale-dismiss'),

  // Weekly report modal
  weeklyModal: document.getElementById('weekly-modal'),
  weeklyX: document.getElementById('weekly-x'),
  weeklyDismiss: document.getElementById('weekly-dismiss'),
  weeklyOpenSettings: document.getElementById('weekly-open-settings'),
  weeklyDup: document.getElementById('weekly-dup'),
  weeklyRes: document.getElementById('weekly-res'),
  weeklyBulk: document.getElementById('weekly-bulk'),
  weeklyTime: document.getElementById('weekly-time'),
};

const tpl = {
  group: document.getElementById('group-template'),
  tab: document.getElementById('tab-template'),
};

const state = {
  tabs: [],
  pinnedTabs: [],
  settings: null,
  query: '',
  groups: new Map(),
  dupeIndex: new Map(),
  // Multi-select: stores merged-row ids (== representative tab.id).
  // Closing a selected row will tear down ALL of that row's _dupeIds.
  selection: new Set(),
  // Tabs the user hasn't activated for > staleDays days. Computed
  // from chrome.storage.local.tabActivity on every reload.
  staleIds: new Set(),
  // Session-only flag: when the user dismisses the stale banner, hide
  // it until the next dashboard reload (don't pester them).
  staleDismissed: false,
  // Drag-and-drop: id of the tab currently being dragged.
  dragTabId: null,
  // AI status state machine, surfaced in the top "AI" chip:
  //   'na'          — current group mode doesn't use AI (domain/window)
  //   'thinking'    — request in flight
  //   'applied'     — last response was OK and overrides were applied
  //   'offline'     — proxy unreachable on last try
  //   'no-result'   — proxy reachable but reply was unusable
  aiStatus: 'na',
  // Disk-backed cache: Map<dupeKey (normalized URL), {category, emoji, savedAt}>.
  // Hydrated from chrome.storage.local on init. Survives restarts, tab close
  // + reopen, even reinstalls (until TTL kicks in). Daily use becomes 0-wait
  // because every previously-seen URL already has its label.
  aiOverridesByUrl: new Map(),
};

// Command palette is mounted lazily on first Cmd+K.
let palette = null;

// ---------------------------------------------------------------------------

init().catch((err) => {
  console.error(err);
  toast('Failed to load tabs: ' + err.message);
});

async function init() {
  state.settings = await loadSettings();
  els.groupMode.value = state.settings.groupMode || 'domain';
  applyTheme(state.settings.theme);
  renderHero();
  bindEvents();
  mountCommandPalette();
  refreshWorkspaces();

  // Hydrate disk-backed AI cache (prunes expired entries in the same call).
  // Done before reload() so the first paint already has cached labels.
  try {
    state.aiOverridesByUrl = await loadAICache();
  } catch (err) {
    console.warn('[smart-new-tab] AI cache hydrate failed:', err);
    state.aiOverridesByUrl = new Map();
  }

  // Stamp today as an active day so we can compute the "X days
  // active" metric honestly. Fire-and-forget — never block UI on it.
  markActiveDay().then(renderImpact).catch(() => {});

  await reload();
  registerTabListeners();

  // Pop the weekly report at most once per ISO week. We delay slightly
  // so the dashboard has time to render its hero — otherwise the modal
  // feels like it's hijacking the page load.
  shouldShowWeeklyReport().then((show) => {
    if (show) setTimeout(showWeeklyReport, 600);
  }).catch(() => {});

  // Cross-tab sync: when the user changes the theme on the options
  // page (or anywhere else), update this newtab without a reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.settings) return;
    const next = changes.settings.newValue;
    if (next?.theme && next.theme !== state.settings.theme) {
      state.settings.theme = next.theme;
      applyTheme(state.settings.theme);
    }
  });
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

  els.refresh.addEventListener('click', async () => {
    // An explicit refresh implies "give me a fresh take" — drop the
    // cached LLM labels (memory + disk) so the next reload triggers a
    // real round-trip.
    await clearAICache();
    reload();
  });
  els.settings.addEventListener('click', openOptions);
  // Clicking the AI chip is the user's signal that they want a fresh
  // classification (e.g. after opening a bunch of new tabs). Disabled
  // while a request is already in flight or AI doesn't apply.
  els.aiChip.addEventListener('click', async () => {
    if (state.aiStatus === 'thinking' || state.aiStatus === 'na') return;
    await clearAICache();
    reload();
  });
  els.google.addEventListener('click', (e) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      window.open('https://www.google.com/', '_blank', 'noopener');
    } else {
      window.location.href = 'https://www.google.com/';
    }
  });
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
    // Cmd/Ctrl+K → command palette. The palette swallows its own
    // shortcut + Esc; we just need to forward the event here so it
    // can decide whether to toggle.
    if (palette) palette.handleGlobalKey(e);
    if (e.defaultPrevented) return;

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

  // Workspaces — "Save current" button
  els.wsNew.addEventListener('click', saveCurrentWorkspace);

  // Stale banner
  els.staleReview.addEventListener('click', () => {
    state.query = '';
    els.search.value = '';
    // Scroll the first stale tab into view if possible.
    const firstStale = [...state.staleIds][0];
    if (firstStale) {
      const node = document.querySelector(`.tab[data-tab-id="${firstStale}"]`);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
  els.staleClose.addEventListener('click', closeStaleTabs);
  els.staleDismiss.addEventListener('click', () => {
    state.staleDismissed = true;
    els.staleBanner.hidden = true;
  });

  // Weekly modal — closing it stamps the ISO week so we don't pop it
  // again this week. Same goes for clicking the backdrop.
  const dismissWeekly = () => {
    els.weeklyModal.hidden = true;
    markWeeklyReportShown().catch(() => {});
  };
  els.weeklyX.addEventListener('click', dismissWeekly);
  els.weeklyDismiss.addEventListener('click', dismissWeekly);
  els.weeklyOpenSettings.addEventListener('click', (e) => {
    e.preventDefault();
    dismissWeekly();
    openOptions();
  });
  els.weeklyModal.addEventListener('click', (e) => {
    if (e.target.dataset.weeklyClose === '1') dismissWeekly();
  });
}

function registerTabListeners() {
  const debounced = debounce(reload, 300);
  chrome.tabs.onCreated.addListener((tab) => {
    touchTab(tab.id).catch(() => {});
    debounced();
  });
  chrome.tabs.onRemoved.addListener(debounced);
  chrome.tabs.onUpdated.addListener((_, info) => {
    if (info.url || info.title || info.favIconUrl) debounced();
  });
  chrome.tabs.onMoved.addListener(debounced);
  chrome.tabs.onAttached.addListener(debounced);
  // Stamp every tab the user actually focuses — this is the "last
  // interaction" signal we use for stale-tab detection.
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    touchTab(tabId).catch(() => {});
  });
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

  // Pinned tabs are surfaced in their own strip — pull them out of
  // the regular group pipeline so they don't double-appear.
  const pinned = tabs.filter((t) => t.pinned);
  const nonPinned = tabs.filter((t) => !t.pinned);
  state.pinnedTabs = pinned;

  // In "by window" mode we want the user to see each window's
  // contents verbatim, so we skip de-duplication there. In all
  // other modes we collapse same-URL tabs into a single row that
  // carries the full id list — clicking × closes one at a time.
  const mode = state.settings.groupMode || 'domain';
  const tabsForGroups = mode === 'window' ? nonPinned : mergeDuplicates(nonPinned);
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

  // Refresh per-tab "last active" stamps + compute stale set.
  await refreshStaleState();

  updateSummary();
  render();
  renderPinned();
  // Recently-closed, workspaces and Impact are independent of the
  // tab list; refresh in parallel without blocking dashboard render.
  refreshRecentlyClosed();
  refreshWorkspaces();
  renderImpact();
  renderStaleBanner();
}

async function refreshStaleState() {
  if (!state.settings.staleEnabled) {
    state.staleIds = new Set();
    return;
  }
  try {
    const ids = state.tabs.map((t) => t.id);
    const map = await syncActivity(ids);
    const stale = findStaleTabIds(map, state.tabs, state.settings.staleDays || 7);
    state.staleIds = new Set(stale);
  } catch (err) {
    console.warn('[smart-new-tab] stale detection failed:', err);
    state.staleIds = new Set();
  }
}

async function buildGroups(tabs) {
  const mode = state.settings.groupMode || 'domain';
  if (mode === 'domain') {
    setAIStatus('na');
    return groupByDomain(tabs);
  }
  if (mode === 'window') {
    setAIStatus('na');
    return groupByWindow(tabs);
  }

  // category mode
  const heuristic = categorizeHeuristic(tabs, {
    userRules: state.settings.userRules,
  });
  if (!state.settings.llm?.enabled) {
    setAIStatus('na');
    return heuristic;
  }

  // Materialize a per-tabId override map from the URL-keyed disk cache.
  // Any tab whose dupeKey is missing from the cache is "uncached" and
  // becomes a candidate for an LLM call below.
  const cachedTabOverrides = new Map();
  const uncachedTabs = [];
  for (const t of tabs) {
    const hit = state.aiOverridesByUrl.get(t.dupeKey);
    if (hit && hit.category) {
      cachedTabOverrides.set(t.id, { category: hit.category, emoji: hit.emoji });
    } else {
      uncachedTabs.push(t);
    }
  }

  // Fully cached: 0-wait happy path. The vast majority of "I opened a
  // new tab" or "I closed a tab" reloads land here.
  if (uncachedTabs.length === 0 && cachedTabOverrides.size > 0) {
    setAIStatus('applied');
    return applyLLMOverrides(heuristic, tabs, cachedTabOverrides);
  }

  // Nothing cached at all (e.g. first ever launch, or user just cleared
  // the cache). Show heuristic immediately, kick off LLM in the background.
  if (cachedTabOverrides.size === 0 && uncachedTabs.length === 0) {
    setAIStatus('na');
    return heuristic;
  }

  // Partial-or-zero cache: paint heuristic + any cached labels first, then
  // ask the LLM ONLY about the uncached tabs. This keeps the prompt small
  // and the round-trip fast.
  setAIStatus('thinking');
  classifyTabsWithLLM(uncachedTabs, state.settings.llm).then(async ({ overrides, status }) => {
    if (status === 'offline') {
      setAIStatus('offline');
      // Cached labels (if any) are still useful — apply them.
      if (cachedTabOverrides.size > 0) {
        state.groups = applyLLMOverrides(heuristic, tabs, cachedTabOverrides);
        render();
      }
      return;
    }
    if (status !== 'ok' || overrides.size === 0) {
      setAIStatus(cachedTabOverrides.size > 0 ? 'applied' : 'no-result');
      if (cachedTabOverrides.size > 0) {
        state.groups = applyLLMOverrides(heuristic, tabs, cachedTabOverrides);
        render();
      }
      return;
    }

    // Persist the new verdicts to disk (URL-keyed) and merge into the
    // tabId-keyed map we're about to apply.
    const byUrl = new Map();
    for (const [tabId, v] of overrides.entries()) {
      const t = uncachedTabs.find((x) => x.id === tabId);
      if (!t) continue;
      byUrl.set(t.dupeKey, v);
      cachedTabOverrides.set(tabId, v);
    }
    try {
      await mergeAICache(state.aiOverridesByUrl, byUrl);
    } catch (err) {
      console.warn('[smart-new-tab] AI cache persist failed:', err);
    }

    state.groups = applyLLMOverrides(heuristic, tabs, cachedTabOverrides);
    setAIStatus('applied');
    render();
    toast('AI grouping applied');
  });

  // Paint immediately with whatever we already have (heuristic + any
  // cached labels). The LLM result will swap in via render() later.
  return cachedTabOverrides.size > 0
    ? applyLLMOverrides(heuristic, tabs, cachedTabOverrides)
    : heuristic;
}

async function clearAICache() {
  state.aiOverridesByUrl = new Map();
  try {
    await clearAICacheDisk();
  } catch (err) {
    console.warn('[smart-new-tab] AI cache clear failed:', err);
  }
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
  node.dataset.groupLabel = info.label;
  // Stable per-group hue so the same site keeps the same accent color
  // across reloads and across windows.
  node.style.setProperty('--group-hue', hashHue(info.label));
  node.querySelector('.group-name').textContent = info.label;
  if (info.aiGenerated) {
    node.querySelector('.group-ai-badge').hidden = false;
    node.classList.add('group-ai');
  }

  const count = items.length;
  node.querySelector('.group-count').textContent = count;
  node.querySelector('.group-count-label').textContent =
    count === 1 ? ' tab open' : ' tabs open';

  // Drag-and-drop reclassify only makes sense in 'category' mode —
  // in 'domain' / 'window' modes the label is mechanical and can't
  // be overridden by a user rule.
  if (state.settings.groupMode === 'category') {
    node.addEventListener('dragover', (e) => {
      if (state.dragTabId == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      node.classList.add('drag-over');
    });
    node.addEventListener('dragleave', () => node.classList.remove('drag-over'));
    node.addEventListener('drop', async (e) => {
      e.preventDefault();
      node.classList.remove('drag-over');
      const draggedId = state.dragTabId;
      state.dragTabId = null;
      if (draggedId == null) return;
      const t = state.tabs.find((x) => x.id === draggedId);
      if (!t) return;
      await reclassifyTabToCategory(t, info.label);
    });
  }

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

  // Stale badge: surfaces tabs the user hasn't touched for a while.
  // We mark the merged-row's representative; if any of its underlying
  // ids is stale, show the badge.
  const rowIds = t._dupeIds || [t.id];
  const isStale = rowIds.some((id) => state.staleIds.has(id));
  if (isStale) {
    node.classList.add('stale');
    const badge = document.createElement('span');
    badge.className = 'tab-stale';
    badge.textContent = '⏰';
    badge.title = `Not opened in ${state.settings.staleDays || 7}+ days`;
    node.querySelector('.tab-text').appendChild(badge);
  }

  // Drag-and-drop: enable only in category mode (see renderGroup).
  if (state.settings.groupMode === 'category') {
    node.draggable = true;
    node.addEventListener('dragstart', (e) => {
      state.dragTabId = t.id;
      node.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(t.id));
    });
    node.addEventListener('dragend', () => {
      state.dragTabId = null;
      node.classList.remove('dragging');
    });
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

  drawSparkline(els.sparkDup,  dailySeries(stats, 7, 'duplicates'));
  drawSparkline(els.sparkRes,  dailySeries(stats, 7, 'restored'));
  drawSparkline(els.sparkBulk, dailySeries(stats, 7, 'bulk'));
}

/**
 * Render a fixed-width sparkline into an existing <svg viewBox="0 0 100 28">.
 * Empty / all-zero series render a flat baseline so the card never
 * looks broken on a fresh install.
 */
function drawSparkline(svg, series) {
  if (!svg) return;
  svg.innerHTML = '';
  const n = series.length;
  if (n === 0) return;
  const max = Math.max(1, ...series);
  const W = 100, H = 28, pad = 2;
  const step = (W - pad * 2) / Math.max(1, n - 1);
  const points = series.map((v, i) => {
    const x = pad + step * i;
    const y = pad + (H - pad * 2) * (1 - v / max);
    return [x, y];
  });

  // Smooth fill + line path
  const lineD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
  const areaD = `${lineD} L ${points[n - 1][0].toFixed(2)} ${H - pad} L ${points[0][0].toFixed(2)} ${H - pad} Z`;

  const ns = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(ns, 'defs');
  defs.innerHTML = `
    <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="var(--brand-1)" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="var(--brand-1)" stop-opacity="0"/>
    </linearGradient>
  `;
  svg.appendChild(defs);

  const area = document.createElementNS(ns, 'path');
  area.setAttribute('class', 'area');
  area.setAttribute('d', areaD);
  svg.appendChild(area);

  const line = document.createElementNS(ns, 'path');
  line.setAttribute('class', 'line');
  line.setAttribute('d', lineD);
  svg.appendChild(line);

  // Dot on the latest point — gives the card a "live pulse" feel.
  const lastP = points[n - 1];
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('class', 'dot');
  dot.setAttribute('cx', lastP[0].toFixed(2));
  dot.setAttribute('cy', lastP[1].toFixed(2));
  dot.setAttribute('r', '2.2');
  svg.appendChild(dot);
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
// Pinned tabs strip
// ---------------------------------------------------------------------------

function renderPinned() {
  if (state.pinnedTabs.length === 0) {
    els.pinnedSection.hidden = true;
    return;
  }
  els.pinnedSection.hidden = false;
  els.pinnedRow.innerHTML = '';

  // De-dupe pinned tabs by URL — if a user pins the same tab in two
  // windows, we still show a single chip (clicking activates the rep).
  const seen = new Map();
  for (const t of state.pinnedTabs) {
    const key = t.dupeKey;
    if (!seen.has(key)) seen.set(key, t);
  }
  for (const t of seen.values()) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pinned-chip';
    chip.title = `${t.title}\n${t.url}`;

    const pin = document.createElement('span');
    pin.className = 'pinned-chip-pin';
    pin.textContent = '📌';
    const img = document.createElement('img');
    img.alt = '';
    img.src = resolveFavicon(t);
    img.loading = 'lazy';
    const label = document.createElement('span');
    label.textContent = t.title || t.host || t.url;

    chip.appendChild(pin);
    chip.appendChild(img);
    chip.appendChild(label);
    chip.addEventListener('click', () => activateTab(t));
    els.pinnedRow.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Workspaces strip
// ---------------------------------------------------------------------------

async function refreshWorkspaces() {
  const list = await listWorkspaces();
  // Re-render: keep the "Save current" chip + append one chip per
  // workspace. Render newest first.
  els.wsRow.innerHTML = '';
  els.wsRow.appendChild(els.wsNew);

  for (const ws of list) {
    const chip = document.createElement('div');
    chip.className = 'ws-chip';
    chip.dataset.wsId = ws.id;
    chip.title = `${ws.tabs.length} tab${ws.tabs.length === 1 ? '' : 's'} · saved ${relativeTime(ws.updatedAt)}\nClick to append · Shift-click to replace · Right-click for more`;

    const icon = document.createElement('span');
    icon.className = 'ws-chip-icon';
    icon.textContent = '💼';
    const label = document.createElement('span');
    label.className = 'ws-chip-label';
    label.textContent = ws.name;
    const meta = document.createElement('span');
    meta.className = 'ws-chip-meta';
    meta.textContent = `${ws.tabs.length}`;
    const actions = document.createElement('span');
    actions.className = 'ws-chip-actions';
    const renameBtn = document.createElement('button');
    renameBtn.className = 'ws-chip-x';
    renameBtn.title = 'Rename';
    renameBtn.textContent = '✎';
    renameBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = prompt('Rename workspace', ws.name);
      if (next && next.trim()) {
        await renameWorkspace(ws.id, next.trim());
        refreshWorkspaces();
      }
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'ws-chip-x';
    delBtn.title = 'Delete';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete workspace "${ws.name}"?`)) return;
      await deleteWorkspace(ws.id);
      refreshWorkspaces();
    });
    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);

    chip.appendChild(icon);
    chip.appendChild(label);
    chip.appendChild(meta);
    chip.appendChild(actions);

    chip.addEventListener('click', async (e) => {
      if (e.target.closest('.ws-chip-x')) return;
      const replace = e.shiftKey;
      try {
        const opened = await restoreWorkspace(ws.id, replace ? 'replace' : 'append');
        recordEvent('restored', opened).then(renderImpact);
        toast(`Restored ${opened} tab${opened === 1 ? '' : 's'}${replace ? ' (replaced current)' : ''}`);
        setTimeout(reload, 250);
      } catch (err) {
        toast('Restore failed: ' + err.message);
      }
    });

    els.wsRow.appendChild(chip);
  }
}

async function saveCurrentWorkspace() {
  // Use the un-pinned, non-internal tab list for the snapshot. We
  // include duplicates intentionally — they were open at this moment.
  const snapshot = state.tabs.filter((t) => !t.pinned);
  if (snapshot.length === 0) {
    toast('Nothing to save — open some tabs first');
    return;
  }
  const name = prompt(`Name this workspace (${snapshot.length} tab${snapshot.length === 1 ? '' : 's'})`, defaultWorkspaceName(snapshot));
  if (name === null) return; // user cancelled
  const trimmed = name.trim() || defaultWorkspaceName(snapshot);
  await createWorkspace(trimmed, snapshot);
  await refreshWorkspaces();
  toast(`Saved "${trimmed}" (${snapshot.length} tab${snapshot.length === 1 ? '' : 's'})`);
}

function defaultWorkspaceName(tabs) {
  // Pick the most-frequent root domain as a hint.
  const counts = new Map();
  for (const t of tabs) {
    const k = t.rootDomain || t.host;
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let top = '';
  let best = 0;
  for (const [k, v] of counts) {
    if (v > best) { top = k; best = v; }
  }
  const today = new Date().toISOString().slice(0, 10);
  return top ? `${top} · ${today}` : `Workspace · ${today}`;
}

// ---------------------------------------------------------------------------
// Stale tab banner
// ---------------------------------------------------------------------------

function renderStaleBanner() {
  if (!state.settings.staleEnabled) {
    els.staleBanner.hidden = true;
    return;
  }
  if (state.staleDismissed || state.staleIds.size === 0) {
    els.staleBanner.hidden = true;
    return;
  }
  els.staleBanner.hidden = false;
  els.staleCount.textContent = state.staleIds.size;
  els.staleDays.textContent = state.settings.staleDays || 7;
}

async function closeStaleTabs() {
  const ids = [...state.staleIds];
  if (ids.length === 0) return;
  if (!confirm(`Close ${ids.length} stale tab${ids.length === 1 ? '' : 's'} that you haven't touched in ${state.settings.staleDays || 7}+ days?`)) return;
  await chrome.tabs.remove(ids);
  // Same accounting as a bulk-close: each closed tab counts.
  recordEvent('bulk', ids.length).then(renderImpact);
  toast(`Closed ${ids.length} stale tab${ids.length === 1 ? '' : 's'}`);
  state.staleDismissed = false;
  setTimeout(reload, 100);
}

// ---------------------------------------------------------------------------
// Weekly report modal
// ---------------------------------------------------------------------------

async function showWeeklyReport() {
  let stats;
  try { stats = await loadStats(); }
  catch { return; }
  const week = summarizeRange(stats, 7);
  els.weeklyDup.textContent  = week.duplicates;
  els.weeklyRes.textContent  = week.restored;
  els.weeklyBulk.textContent = week.bulk;
  els.weeklyTime.textContent = formatDuration(week.timeSavedSec);

  // Sub-line: if there's literally nothing happening, still show
  // something encouraging instead of a blank stat panel.
  const total = week.duplicates + week.restored + week.bulk;
  els.weeklyModal.querySelector('#weekly-sub').textContent = total > 0
    ? `Your last 7 days at a glance — keep it up.`
    : `No actions last week yet. Try the dedupe pill or right-click a tab — these stats grow as you use the dashboard.`;

  els.weeklyModal.hidden = false;
}

// ---------------------------------------------------------------------------
// Drag-and-drop reclassify
// ---------------------------------------------------------------------------

async function reclassifyTabToCategory(tab, categoryLabel) {
  // Persist a user rule so the change sticks across reloads.
  // Earliest-match-wins, so we prepend.
  const match = tab.host || tab.rootDomain || tab.url;
  if (!match || !categoryLabel) return;
  const rules = Array.isArray(state.settings.userRules) ? state.settings.userRules : [];
  // De-dupe: if a rule for this host already exists, update it in place.
  const existing = rules.find((r) => (r.match || '').toLowerCase() === match.toLowerCase());
  if (existing) {
    existing.category = categoryLabel;
  } else {
    rules.unshift({ match, category: categoryLabel, emoji: '' });
  }
  state.settings.userRules = rules;
  await saveSettings(state.settings);
  toast(`Moved "${tab.host || match}" → ${categoryLabel}`);
  await reload();
}

// ---------------------------------------------------------------------------
// Command palette wiring
// ---------------------------------------------------------------------------

function mountCommandPalette() {
  palette = createCommandPalette({
    /** Plug the palette into our existing tab/group state. */
    searchTabs: async (q) => {
      const results = [];
      const ql = q.toLowerCase();
      for (const g of state.groups.values()) {
        for (const t of g.items) {
          if (!ql || matchTab(t, ql)) {
            results.push({
              kind: 'tab',
              tab: t,
              label: t.title || t.url,
              hint: `${g.info.label} · ${t.host}`,
              icon: '↗',
            });
          }
          if (results.length >= 40) break;
        }
      }
      return results;
    },
    onAction: handlePaletteAction,
  });
}

async function handlePaletteAction(action) {
  switch (action.type) {
    case 'activate-tab':
      await activateTab(action.tab);
      break;
    case 'close-duplicates':
      await closeDuplicates();
      break;
    case 'close-all':
      await closeEverything();
      break;
    case 'restore-last':
      try {
        if (chrome.sessions?.getRecentlyClosed) {
          const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 1 });
          const s = sessions[0];
          const id = s?.tab?.sessionId || s?.window?.sessionId;
          if (id) {
            await chrome.sessions.restore(id);
            const amount = s.window ? (s.window.tabs?.length || 1) : 1;
            recordEvent('restored', amount).then(renderImpact);
            setTimeout(reload, 200);
          } else {
            toast('Nothing to restore');
          }
        }
      } catch (err) {
        toast('Restore failed: ' + err.message);
      }
      break;
    case 'bookmark-all':
      try {
        let n = 0;
        for (const t of state.tabs) {
          try { await chrome.bookmarks.create({ title: t.title, url: t.url }); n++; } catch {}
        }
        toast(`Bookmarked ${n} tab${n === 1 ? '' : 's'}`);
      } catch (err) {
        toast('Bookmark failed: ' + err.message);
      }
      break;
    case 'workspace-save':
      await saveCurrentWorkspace();
      break;
    case 'open-settings':
      openOptions();
      break;
    case 'theme': {
      const next = applyTheme(action.theme);
      state.settings.theme = next;
      await saveSettings(state.settings);
      toast(`Theme: ${next.charAt(0).toUpperCase() + next.slice(1)}`);
      break;
    }
    case 'google':
      searchOnGoogle(action.query, false);
      break;
    default:
      console.warn('Unknown palette action:', action);
  }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function openOptions() {
  chrome.runtime.openOptionsPage();
}

// AI status chip in the "Open tabs" header. Surfaces whether AI grouping
// is currently in play, and why (mode, in-flight, offline, applied).
function setAIStatus(s) {
  state.aiStatus = s;
  if (!els.aiChip) return;
  const clickHint = '\n\nClick to re-classify with a fresh LLM call.';
  const labelByState = {
    'na':        { label: '',                hidden: true,  tip: '' },
    'thinking':  { label: 'AI thinking…',    hidden: false, tip: 'Asking cursor-agent to group these tabs.' },
    'applied':   { label: `AI · ${state.settings?.llm?.model || 'sonnet-4'}`,
                                              hidden: false, tip: 'LLM groupings are layered on top of the heuristic ones.' + clickHint },
    'offline':   { label: 'AI offline',      hidden: false, tip: 'cursor-llm-proxy unreachable on 127.0.0.1:8788. Start it with: bash tools/cursor-llm-proxy/start.sh' + clickHint },
    'no-result': { label: 'AI · no changes', hidden: false, tip: 'LLM replied but the result was empty or unparseable.' + clickHint },
  };
  const cfg = labelByState[s] || labelByState['na'];
  els.aiChip.hidden = cfg.hidden;
  els.aiChip.dataset.state = s;
  els.aiChip.title = cfg.tip;
  els.aiChip.querySelector('.ai-chip-label').textContent = cfg.label;
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/**
 * Map an arbitrary string (e.g. a site name) to a stable hue in [0, 360).
 * Two calls with the same input always return the same hue, so a site
 * keeps the same accent color across reloads. Implementation is a
 * classic djb2-style rolling hash, sampled mod 360.
 */
function hashHue(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
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
