import { fetchAllTabs, indexByDupeKey, resolveFavicon } from './lib/tabs.js';
import {
  categorizeHeuristic,
  applyLLMOverrides,
} from './lib/categorize.js';
import { siteNameFor } from './lib/site-names.js';
import { loadSettings, saveSettings } from './lib/storage.js';
import { classifyTabsWithLLM } from './lib/llm.js';

const els = {
  greeting: document.getElementById('greeting'),
  heroDate: document.getElementById('hero-date'),

  search: document.getElementById('search-input'),
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
  await reload();
  registerTabListeners();
}

function bindEvents() {
  els.search.addEventListener('input', (e) => {
    state.query = e.target.value.trim().toLowerCase();
    render();
  });
  els.refresh.addEventListener('click', () => reload());
  els.settings.addEventListener('click', openOptions);
  els.openOptions.addEventListener('click', (e) => { e.preventDefault(); openOptions(); });

  els.groupMode.addEventListener('change', async () => {
    state.settings.groupMode = els.groupMode.value;
    await saveSettings(state.settings);
    await reload();
  });

  els.dedupeBtn.addEventListener('click', closeDuplicates);
  els.closeAllBtn.addEventListener('click', closeEverything);

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== els.search) {
      e.preventDefault();
      els.search.focus();
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
  state.groups = await buildGroups(tabs);

  updateSummary();
  render();
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
    const empty = els.emptyState.cloneNode(true);
    empty.hidden = false;
    els.board.appendChild(empty);
    return;
  }

  for (const g of matchedGroups) els.board.appendChild(renderGroup(g));
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

  const closeBtn = node.querySelector('.group-close-all');
  closeBtn.querySelector('.group-close-label').textContent =
    `Close all ${count} ${count === 1 ? 'tab' : 'tabs'}`;
  closeBtn.addEventListener('click', async () => {
    if (count > 1 && !confirm(`Close all ${count} tabs in "${info.label}"?`)) return;
    const ids = items.map((t) => t.id).filter((id) => Number.isInteger(id));
    await chrome.tabs.remove(ids);
    await reload();
    toast(`Closed ${ids.length} tab${ids.length === 1 ? '' : 's'}`);
  });

  return node;
}

function renderTab(t) {
  const node = tpl.tab.content.firstElementChild.cloneNode(true);
  node.dataset.tabId = t.id;

  node.querySelector('.tab-favicon').src = resolveFavicon(t);
  node.querySelector('.tab-title').textContent = t.title || t.url;
  node.title = `${t.title || ''}\n${t.url}`;

  const dupeList = state.dupeIndex.get(t.dupeKey) || [];
  if (dupeList.length > 1) {
    node.classList.add('duplicate');
    const dupe = node.querySelector('.tab-dupe');
    node.querySelector('.tab-dupe-count').textContent = dupeList.length;
    dupe.hidden = false;
  }

  node.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    activateTab(t);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateTab(t);
    }
  });

  node.querySelector('.tab-close').addEventListener('click', async (e) => {
    e.stopPropagation();
    await chrome.tabs.remove(t.id);
    node.style.transition = 'opacity .15s';
    node.style.opacity = '0';
    setTimeout(reload, 150);
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
  await reload();
  toast(`Closed ${toClose.length} duplicate${toClose.length === 1 ? '' : 's'}`);
}

async function closeEverything() {
  const ids = state.tabs.map((t) => t.id).filter((id) => Number.isInteger(id));
  if (ids.length === 0) return;
  if (!confirm(`Close all ${ids.length} open tabs across every window?`)) return;
  await chrome.tabs.remove(ids);
  await reload();
  toast(`Closed ${ids.length} tabs`);
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
