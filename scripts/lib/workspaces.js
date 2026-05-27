/**
 * Workspaces — named snapshots of all open tabs.
 *
 * A workspace is just a small JSON record:
 *   {
 *     id: 'ws_<unix>_<rand>',
 *     name: 'Project Alpha',
 *     createdAt: 1748600000,
 *     updatedAt: 1748600000,
 *     tabs: [{ url, title, favIconUrl }]
 *   }
 *
 * Stored under chrome.storage.local.workspaces as an array, ordered
 * most-recent first. We hand-roll a tiny id so the UI can stable-key
 * each chip without depending on `name` (which the user can rename).
 */

const KEY = 'workspaces';

export async function listWorkspaces() {
  const got = await chrome.storage.local.get(KEY);
  const arr = got[KEY];
  return Array.isArray(arr) ? arr : [];
}

async function saveAll(arr) {
  await chrome.storage.local.set({ [KEY]: arr });
}

function newId() {
  const t = Math.floor(Date.now() / 1000).toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `ws_${t}_${r}`;
}

/**
 * Create a workspace from the current set of NormalizedTab objects.
 * The tabs array is shrunk to just (url, title, favIconUrl) so we
 * don't bloat storage with transient ids / window ids.
 */
export async function createWorkspace(name, tabs) {
  const list = await listWorkspaces();
  const now = Math.floor(Date.now() / 1000);
  const ws = {
    id: newId(),
    name: name || `Workspace ${list.length + 1}`,
    createdAt: now,
    updatedAt: now,
    tabs: tabs.map((t) => ({
      url: t.url,
      title: t.title || t.url,
      favIconUrl: t.favIconUrl || '',
    })),
  };
  list.unshift(ws);
  await saveAll(list);
  return ws;
}

export async function deleteWorkspace(id) {
  const list = await listWorkspaces();
  const next = list.filter((w) => w.id !== id);
  await saveAll(next);
  return next;
}

export async function renameWorkspace(id, name) {
  const list = await listWorkspaces();
  const w = list.find((w) => w.id === id);
  if (!w) return null;
  w.name = name;
  w.updatedAt = Math.floor(Date.now() / 1000);
  await saveAll(list);
  return w;
}

/**
 * Restore mode:
 *  - 'replace': close every currently-open tab first, then open the
 *               workspace fresh. The current new-tab page itself is
 *               preserved so we have somewhere to land.
 *  - 'append' : just open the workspace's tabs in the current window;
 *               keep everything else open.
 *
 * Returns the number of tabs that were opened.
 */
export async function restoreWorkspace(id, mode = 'append') {
  const list = await listWorkspaces();
  const ws = list.find((w) => w.id === id);
  if (!ws) throw new Error('Workspace not found');

  const win = await chrome.windows.getCurrent();
  const meTab = await chrome.tabs.getCurrent();
  const meId = meTab?.id;

  if (mode === 'replace') {
    const all = await chrome.tabs.query({ windowType: 'normal' });
    const toClose = all.map((t) => t.id).filter((id) => id !== meId);
    if (toClose.length > 0) await chrome.tabs.remove(toClose);
  }

  let opened = 0;
  for (const t of ws.tabs) {
    try {
      await chrome.tabs.create({ url: t.url, windowId: win.id, active: false });
      opened++;
    } catch {
      // Some URLs (chrome://settings/, view-source:, etc.) can't be
      // recreated by an extension. Skip them silently — the user can
      // still see them in the workspace metadata.
    }
  }
  return opened;
}
