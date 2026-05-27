/**
 * Cmd+K command palette.
 *
 * Self-contained: builds its own DOM on first open, registers global
 * keyboard shortcuts (Cmd+K / Ctrl+K to open, Esc to close, ↑↓ to
 * navigate, Enter to execute), and dispatches commands via a single
 * `onAction` callback supplied by the host.
 *
 * Two modes share a single input:
 *  - Default: searches tabs by title/url/host (handled by the host
 *    via `host.searchTabs(query)` -> [{kind:'tab', tab, label, hint}])
 *  - Command: input starts with '>'. We filter a built-in command list
 *    and display matched actions for the user to execute.
 */

const HOST_ID = 'cmdk-host';

export function createCommandPalette(host) {
  /** Build (once) the DOM and wire global events. */
  let root, input, list, hintEl;
  let isOpen = false;
  let currentResults = [];
  let activeIndex = 0;

  function build() {
    root = document.createElement('div');
    root.id = HOST_ID;
    root.className = 'cmdk';
    root.hidden = true;
    root.innerHTML = `
      <div class="cmdk-backdrop" data-close="1"></div>
      <div class="cmdk-panel" role="dialog" aria-label="Command palette">
        <div class="cmdk-input-row">
          <span class="cmdk-prompt">⌘K</span>
          <input class="cmdk-input" type="text" autocomplete="off"
                 placeholder="Search tabs… (type ' > ' for commands)" />
          <kbd class="cmdk-kbd">Esc</kbd>
        </div>
        <ul class="cmdk-list" role="listbox"></ul>
        <div class="cmdk-hint">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>&gt;</kbd> commands</span>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    input = root.querySelector('.cmdk-input');
    list = root.querySelector('.cmdk-list');
    hintEl = root.querySelector('.cmdk-hint');

    root.addEventListener('click', (e) => {
      if (e.target.dataset.close === '1') close();
    });
    input.addEventListener('input', () => {
      activeIndex = 0;
      refresh();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (currentResults.length === 0) return;
        activeIndex = (activeIndex + 1) % currentResults.length;
        renderList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (currentResults.length === 0) return;
        activeIndex = (activeIndex - 1 + currentResults.length) % currentResults.length;
        renderList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        executeActive();
      }
    });
  }

  function open() {
    if (!root) build();
    isOpen = true;
    root.hidden = false;
    input.value = '';
    activeIndex = 0;
    refresh();
    setTimeout(() => input.focus(), 0);
  }

  function close() {
    if (!root) return;
    isOpen = false;
    root.hidden = true;
  }

  function toggle() { isOpen ? close() : open(); }

  async function refresh() {
    const q = input.value;
    if (q.trim().startsWith('>')) {
      currentResults = filterCommands(q.trim().slice(1).trim().toLowerCase());
    } else {
      currentResults = (await host.searchTabs(q.trim())).slice(0, 30);
    }
    if (activeIndex >= currentResults.length) activeIndex = 0;
    renderList();
  }

  function filterCommands(needle) {
    const cmds = buildCommands(host);
    if (!needle) return cmds;
    return cmds.filter((c) =>
      c.label.toLowerCase().includes(needle) ||
      (c.keywords || '').toLowerCase().includes(needle),
    );
  }

  function renderList() {
    list.innerHTML = '';
    if (currentResults.length === 0) {
      const li = document.createElement('li');
      li.className = 'cmdk-empty';
      const q = input.value.trim();
      if (q && !q.startsWith('>')) {
        li.innerHTML = `No match — press <kbd>↵</kbd> to Google "${escapeHtml(q)}"`;
        currentResults = [{
          kind: 'google',
          label: q,
          run: () => host.onAction({ type: 'google', query: q }),
        }];
        activeIndex = 0;
      } else {
        li.textContent = 'No commands match';
      }
      list.appendChild(li);
      return;
    }
    currentResults.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'cmdk-item' + (i === activeIndex ? ' active' : '');
      li.setAttribute('role', 'option');
      const icon = document.createElement('span');
      icon.className = 'cmdk-icon';
      icon.textContent = r.icon || (r.kind === 'tab' ? '↗' : '⚡');
      const text = document.createElement('div');
      text.className = 'cmdk-text';
      const label = document.createElement('div');
      label.className = 'cmdk-label';
      label.textContent = r.label;
      text.appendChild(label);
      if (r.hint) {
        const hint = document.createElement('div');
        hint.className = 'cmdk-row-hint';
        hint.textContent = r.hint;
        text.appendChild(hint);
      }
      li.appendChild(icon);
      li.appendChild(text);
      li.addEventListener('mouseenter', () => { activeIndex = i; renderList(); });
      li.addEventListener('click', () => { activeIndex = i; executeActive(); });
      list.appendChild(li);
    });
  }

  async function executeActive() {
    const r = currentResults[activeIndex];
    if (!r) return;
    if (typeof r.run === 'function') {
      close();
      await r.run();
      return;
    }
    if (r.kind === 'tab' && r.tab) {
      close();
      host.onAction({ type: 'activate-tab', tab: r.tab });
    }
  }

  // Global open shortcut. We can't blanket-listen on `keydown` here
  // because the host page already has its own / shortcut etc., so we
  // expose `handleGlobalKey` instead and let the host wire it.
  function handleGlobalKey(e) {
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const cmd = isMac ? e.metaKey : e.ctrlKey;
    if (cmd && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      toggle();
    } else if (isOpen && e.key === 'Escape') {
      close();
    }
  }

  return { open, close, toggle, handleGlobalKey };
}

/** Static command list. Each item has { id, label, hint, keywords, run }. */
function buildCommands(host) {
  return [
    {
      kind: 'cmd', id: 'dedupe', icon: '🧹',
      label: 'Close all duplicates',
      hint: 'Keep one tab per unique URL',
      keywords: 'dedupe duplicate clean',
      run: () => host.onAction({ type: 'close-duplicates' }),
    },
    {
      kind: 'cmd', id: 'close-all', icon: '✕',
      label: 'Close all open tabs',
      hint: 'Across every window (confirmation required)',
      keywords: 'close all everything wipe',
      run: () => host.onAction({ type: 'close-all' }),
    },
    {
      kind: 'cmd', id: 'restore', icon: '↺',
      label: 'Restore most recently closed',
      hint: 'Same as the top of the Recently closed list',
      keywords: 'restore reopen undo',
      run: () => host.onAction({ type: 'restore-last' }),
    },
    {
      kind: 'cmd', id: 'bookmark-all', icon: '⭐',
      label: 'Bookmark every open tab',
      hint: 'Each tab is added to your default bookmarks',
      keywords: 'bookmark save star all',
      run: () => host.onAction({ type: 'bookmark-all' }),
    },
    {
      kind: 'cmd', id: 'workspace-save', icon: '💼',
      label: 'Save current tabs as Workspace…',
      hint: 'Snapshot every open tab under a name',
      keywords: 'workspace save snapshot session',
      run: () => host.onAction({ type: 'workspace-save' }),
    },
    {
      kind: 'cmd', id: 'open-settings', icon: '⚙',
      label: 'Open Settings',
      hint: 'Theme, custom rules, AI grouping…',
      keywords: 'settings preferences options',
      run: () => host.onAction({ type: 'open-settings' }),
    },
    {
      kind: 'cmd', id: 'theme-lavender', icon: '🟣',
      label: 'Switch theme · Lavender',
      keywords: 'theme purple lavender',
      run: () => host.onAction({ type: 'theme', theme: 'lavender' }),
    },
    {
      kind: 'cmd', id: 'theme-ocean', icon: '🔵',
      label: 'Switch theme · Ocean',
      keywords: 'theme blue ocean',
      run: () => host.onAction({ type: 'theme', theme: 'ocean' }),
    },
    {
      kind: 'cmd', id: 'theme-forest', icon: '🟢',
      label: 'Switch theme · Forest',
      keywords: 'theme green forest',
      run: () => host.onAction({ type: 'theme', theme: 'forest' }),
    },
    {
      kind: 'cmd', id: 'theme-sunset', icon: '🟠',
      label: 'Switch theme · Sunset',
      keywords: 'theme orange sunset',
      run: () => host.onAction({ type: 'theme', theme: 'sunset' }),
    },
  ];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
