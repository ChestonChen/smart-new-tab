import { fetchAllTabs, indexByDupeKey, resolveFavicon } from './lib/tabs.js';
import {
  categorizeHeuristic,
  applyLLMOverrides,
  OTHER_CATEGORY,
} from './lib/categorize.js';
import { loadSettings, saveSettings } from './lib/storage.js';
import { classifyTabsWithLLM } from './lib/llm.js';

const els = {
  brandSub: document.getElementById('brand-sub'),
  search: document.getElementById('search-input'),
  refresh: document.getElementById('refresh-btn'),
  settings: document.getElementById('settings-btn'),
  groupMode: document.getElementById('group-mode'),
  dedupe: document.getElementById('dedupe-btn'),
  board: document.getElementById('board'),
  emptyState: document.getElementById('empty-state'),
  aiStatusValue: document.getElementById('ai-status-value'),
  openOptions: document.getElementById('open-options'),
  statTabs: document.getElementById('stat-tabs'),
  statWindows: document.getElementById('stat-windows'),
  statDomains: document.getElementById('stat-domains'),
  statDupes: document.getElementById('stat-dupes'),
};

const tpl = {
  group: document.getElementById('group-template'),
  tab: document.getElementById('tab-template'),
};

const state = {
  tabs: [],
  settings: null,
  query: '',
  groups: new Map(), // current displayed groups
  dupeIndex: new Map(),
};

// ---------------------------------------------------------------------------

init().catch((err) => {
  console.error(err);
  toast('Failed to load tabs: ' + err.message);
});

async function init() {
  state.settings = await loadSettings();
  els.groupMode.value = state.settings.groupMode || 'category';
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

  els.dedupe.addEventListener('click', closeDuplicates);

  // Keyboard: '/' focuses search.
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

async function reload() {
  els.brandSub.textContent = 'Loading…';
  els.dedupe.disabled = true;

  const tabs = await fetchAllTabs({
    includeInternal: state.settings.showInternalPages,
  });
  state.tabs = tabs;
  state.dupeIndex = indexByDupeKey(tabs);

  state.groups = await buildGroups(tabs);

  updateStats();
  render();
  els.dedupe.disabled = false;
}

async function buildGroups(tabs) {
  const mode = state.settings.groupMode || 'category';
  if (mode === 'domain') return groupByRootDomain(tabs);
  if (mode === 'window') return groupByWindow(tabs);

  // category mode
  const heuristic = categorizeHeuristic(tabs, {
    userRules: state.settings.userRules,
  });

  if (!state.settings.llm?.enabled) return heuristic;

  // Run LLM in the background and re-render when ready.
  classifyTabsWithLLM(tabs, state.settings.llm).then((overrides) => {
    if (!overrides || overrides.size === 0) return;
    const merged = applyLLMOverrides(heuristic, tabs, overrides);
    state.groups = merged;
    render();
    toast('AI grouping applied');
  });

  return heuristic;
}

function groupByRootDomain(tabs) {
  const groups = new Map();
  for (const t of tabs) {
    const id = 'dom:' + (t.rootDomain || 'unknown');
    const info = {
      id,
      label: t.rootDomain || 'Unknown',
      emoji: '🌐',
    };
    if (!groups.has(id)) groups.set(id, { info, items: [] });
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
    const info = { id, label: `Window ${t.windowId}`, emoji: '🪟' };
    if (!groups.has(id)) groups.set(id, { info, items: [] });
    groups.get(id).items.push(t);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function updateStats() {
  const tabs = state.tabs;
  els.statTabs.textContent = tabs.length;
  els.statWindows.textContent = new Set(tabs.map((t) => t.windowId)).size;
  els.statDomains.textContent = new Set(tabs.map((t) => t.rootDomain)).size;

  let dupes = 0;
  for (const arr of state.dupeIndex.values()) if (arr.length > 1) dupes += arr.length - 1;
  els.statDupes.textContent = dupes;
  els.statDupes.dataset.zero = dupes === 0 ? 'true' : 'false';

  els.brandSub.textContent =
    tabs.length === 0
      ? 'No open tabs to show.'
      : `${tabs.length} tabs across ${els.statWindows.textContent} window${els.statWindows.textContent === '1' ? '' : 's'}`;
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

  for (const g of matchedGroups) {
    els.board.appendChild(renderGroup(g));
  }
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
  node.querySelector('.group-emoji').textContent = info.emoji || '📁';
  node.querySelector('.group-name').textContent = info.label;
  node.querySelector('.group-count').textContent = items.length;

  const list = node.querySelector('.tab-list');
  for (const t of items) list.appendChild(renderTab(t));

  node.querySelector('.group-collapse').addEventListener('click', () => {
    node.classList.toggle('collapsed');
  });
  node.querySelector('.group-close-all').addEventListener('click', async () => {
    if (!confirm(`Close all ${items.length} tabs in "${info.label}"?`)) return;
    const ids = items.map((t) => t.id).filter((id) => Number.isInteger(id));
    await chrome.tabs.remove(ids);
    await reload();
    toast(`Closed ${ids.length} tabs`);
  });

  return node;
}

function renderTab(t) {
  const node = tpl.tab.content.firstElementChild.cloneNode(true);
  node.dataset.tabId = t.id;

  node.querySelector('.favicon').src = resolveFavicon(t);
  node.querySelector('.tab-title').textContent = t.title || t.url;
  node.querySelector('.tab-domain').textContent = t.host || '—';

  // window badge in non-window grouping modes
  if (state.settings.groupMode !== 'window') {
    const winBadge = node.querySelector('.tab-window-badge');
    winBadge.textContent = `w${t.windowId}`;
    winBadge.hidden = false;
  }

  const dupeList = state.dupeIndex.get(t.dupeKey) || [];
  if (dupeList.length > 1) {
    node.classList.add('duplicate');
    const badge = node.querySelector('.tab-dupe-badge');
    node.querySelector('.tab-dupe-count').textContent = dupeList.length;
    badge.hidden = false;
  }

  // activate (switch) on click
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
// Dedupe
// ---------------------------------------------------------------------------

async function closeDuplicates() {
  const toClose = [];
  for (const arr of state.dupeIndex.values()) {
    if (arr.length <= 1) continue;
    // Prefer keeping pinned tabs; otherwise keep the oldest (smallest id).
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

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function updateAIStatusBadge() {
  const enabled = !!state.settings?.llm?.enabled;
  els.aiStatusValue.textContent = enabled ? 'on' : 'off';
  els.aiStatusValue.style.color = enabled ? 'var(--success)' : 'var(--text-mute)';
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
