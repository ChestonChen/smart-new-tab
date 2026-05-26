/**
 * Service worker — mostly idle. The new-tab UI itself queries chrome.tabs
 * directly, so we only need to handle a couple of edge cases here.
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[smart-new-tab] installed');
});

// Clicking the toolbar action focuses (or opens) the new tab page so the
// user can jump into the dashboard without spawning a fresh tab every time.
chrome.action.onClicked.addListener(async () => {
  const newTabUrl = chrome.runtime.getURL('newtab.html');
  const existing = await chrome.tabs.query({ url: newTabUrl });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: 'chrome://newtab/' });
  }
});
