/**
 * Theme palette catalog + applier.
 *
 * Each theme is a tuple of (brand colors, base background, mesh blobs)
 * we hand off to CSS as data-theme attribute. The actual CSS lives in
 * styles/newtab.css under `body[data-theme="..."]`.
 *
 * We also expose a small metadata array so the options page (and the
 * Cmd+K palette) can render a picker without hard-coding the list.
 */

export const THEMES = [
  {
    id: 'lavender',
    label: 'Lavender',
    swatches: ['#A48CFF', '#FFA7CE', '#FFB8A8', '#9CC0FF'],
    description: 'Default — purple-pink dawn',
  },
  {
    id: 'ocean',
    label: 'Ocean',
    swatches: ['#3D7BFF', '#6EC3FF', '#3DDFE2', '#9C8CFF'],
    description: 'Cool blues, focused work mode',
  },
  {
    id: 'forest',
    label: 'Forest',
    swatches: ['#4FB286', '#A4D77F', '#FFD27A', '#7DD3C0'],
    description: 'Soft greens, easy on the eyes',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    swatches: ['#FF8967', '#FFB347', '#FF6F91', '#C2A4FF'],
    description: 'Warm oranges for late-day energy',
  },
];

const THEME_IDS = new Set(THEMES.map((t) => t.id));

export function applyTheme(themeId) {
  const id = THEME_IDS.has(themeId) ? themeId : 'lavender';
  document.body.dataset.theme = id;
  return id;
}

export function themeMeta(themeId) {
  return THEMES.find((t) => t.id === themeId) || THEMES[0];
}
