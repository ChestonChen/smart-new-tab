/**
 * Wrapper around chrome.bookmarks. Surfaces the *Bookmarks Bar* subtree
 * (Chrome's "1" node) as a clean nested structure for the dashboard's
 * faux-bookmarks-bar strip.
 *
 * Why only the bar and not the whole tree? The strip mimics Chrome's
 * own bookmarks bar — anything in "Other bookmarks" or "Mobile bookmarks"
 * intentionally stays out of sight, exactly like the real thing.
 *
 * Node shape:
 *   {
 *     id:       string,
 *     title:    string,
 *     url?:     string,                // present iff this is a bookmark
 *     children?: BookmarkNode[],       // present iff this is a folder
 *   }
 *
 * A node with `url` is a bookmark; a node with `children` is a folder.
 * The two are mutually exclusive in chrome.bookmarks.
 */

/**
 * Resolve to the children of the bookmark bar, in their Chrome order.
 * If the API call fails (e.g. extension lacking permission), returns []
 * and logs a console warning — the strip will simply render empty rather
 * than crash the page.
 */
export async function loadBookmarkBarChildren() {
  try {
    // chrome.bookmarks.getChildren walks one level. The Bookmark Bar is
    // always id "1" in Chrome (and Edge, Brave — all Chromium-based).
    // If a different vendor returns something funky we'll fall through
    // to the catch and surface an empty strip.
    const children = await chrome.bookmarks.getChildren('1');
    // Children come back without a `children` array even for folders;
    // chrome.bookmarks.getChildren returns just the direct level. We
    // lazily fetch sub-folder contents on demand in expandFolder().
    return children.map(normalize);
  } catch (err) {
    console.warn('[smart-new-tab] failed to load bookmark bar:', err);
    return [];
  }
}

/**
 * Fetch the direct children of a folder node. Used when the user opens
 * a folder dropdown. Same fallback discipline as loadBookmarkBarChildren.
 */
export async function loadFolderChildren(folderId) {
  try {
    const children = await chrome.bookmarks.getChildren(folderId);
    return children.map(normalize);
  } catch (err) {
    console.warn('[smart-new-tab] failed to load folder children:', err);
    return [];
  }
}

export function isFolder(node) {
  return !!node && !node.url;
}

/**
 * Best-effort favicon for a bookmark URL. Mirrors lib/tabs.js
 * resolveFavicon() but takes a URL string (bookmarks don't carry
 * favIconUrl). Uses the bundled `_favicon` permission endpoint so we
 * never hit the network from the new-tab page.
 */
export function bookmarkFavicon(url) {
  try {
    const u = new URL(chrome.runtime.getURL('/_favicon/'));
    u.searchParams.set('pageUrl', url);
    u.searchParams.set('size', '32');
    return u.toString();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------

function normalize(b) {
  // Strip everything we don't need — manifest version, dateAdded, etc.
  // are noise for the strip and keep state objects small.
  if (b.url) {
    return { id: b.id, title: b.title || b.url, url: b.url };
  }
  return { id: b.id, title: b.title || 'Folder' };
}
