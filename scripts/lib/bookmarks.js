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
 * Resolve to the items that should populate the strip. Returns, in order:
 *   1. The direct children of the Bookmarks Bar (id "1")
 *   2. A synthetic "Other bookmarks" folder chip (id "2") iff that root
 *      has any content
 *
 * Why surface "Other bookmarks"? Chrome's own bookmarks bar shows it as
 * a right-edge dropdown so users whose bookmarks live there can still
 * reach them in one click. Mirroring that means our strip is useful
 * regardless of whether someone organizes via the Bookmarks Bar or
 * dumps everything into the default location.
 *
 * The "2" id is real — it's just chrome.bookmarks's id for the Other
 * Bookmarks root. Clicking the synthetic chip therefore reuses the
 * same loadFolderChildren("2") path as any other folder, no special-
 * casing needed downstream.
 *
 * If the API call fails (e.g. extension lacking permission), returns []
 * and logs a console warning — the strip will simply render empty rather
 * than crash the page.
 */
export async function loadBookmarkBarChildren() {
  try {
    // Bookmark roots are stable across all Chromium browsers:
    //   "1" = Bookmarks Bar     "2" = Other bookmarks     "3" = Mobile
    const [barChildren, otherChildren] = await Promise.all([
      chrome.bookmarks.getChildren('1'),
      chrome.bookmarks.getChildren('2').catch(() => []),
    ]);
    const out = barChildren.map(normalize);
    if (otherChildren.length > 0) {
      out.push({ id: '2', title: 'Other bookmarks' });
    }
    return out;
  } catch (err) {
    console.warn('[smart-new-tab] failed to load bookmark roots:', err);
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
