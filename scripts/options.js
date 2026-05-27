import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './lib/storage.js';
import { loadStats, resetStats, lifetimeSummary, formatDuration } from './lib/stats.js';
import { THEMES } from './lib/themes.js';

const els = {
  groupMode: document.getElementById('group-mode'),
  showInternal: document.getElementById('show-internal'),
  themeGrid: document.getElementById('theme-grid'),
  staleEnabled: document.getElementById('stale-enabled'),
  staleDays: document.getElementById('stale-days'),
  userRules: document.getElementById('user-rules'),
  addRule: document.getElementById('add-rule'),
  save: document.getElementById('save'),
  saveState: document.getElementById('save-state'),
  impactSummary: document.getElementById('impact-summary'),
  resetStats: document.getElementById('reset-stats'),
};

const ruleTpl = document.getElementById('rule-row');
let settings = structuredClone(DEFAULT_SETTINGS);

init();

async function init() {
  settings = await loadSettings();
  hydrate();
  bind();
  refreshImpactSummary();
}

function hydrate() {
  els.groupMode.value = settings.groupMode || 'category';
  els.showInternal.checked = !!settings.showInternalPages;
  els.staleEnabled.checked = settings.staleEnabled !== false;
  els.staleDays.value = settings.staleDays || 7;
  renderThemePicker();

  els.userRules.innerHTML = '';
  for (const r of settings.userRules || []) addRuleRow(r);
}

function renderThemePicker() {
  els.themeGrid.innerHTML = '';
  const selected = settings.theme || 'lavender';
  for (const t of THEMES) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'theme-tile' + (t.id === selected ? ' selected' : '');
    tile.dataset.themeId = t.id;
    tile.innerHTML = `
      <span class="theme-swatch" style="background: linear-gradient(135deg,
        ${t.swatches[0]} 0%, ${t.swatches[1]} 35%,
        ${t.swatches[2]} 65%, ${t.swatches[3]} 100%);"></span>
      <span class="theme-meta">
        <span class="theme-name">${escapeHtml(t.label)}</span>
        <span class="theme-desc">${escapeHtml(t.description)}</span>
      </span>
    `;
    tile.addEventListener('click', async () => {
      settings.theme = t.id;
      // Persist immediately so any open newtab pages re-skin instantly
      // via the storage.onChanged listener.
      await saveSettings(settings);
      renderThemePicker();
    });
    els.themeGrid.appendChild(tile);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function bind() {
  els.addRule.addEventListener('click', () => addRuleRow({}));
  els.save.addEventListener('click', persist);
  els.resetStats.addEventListener('click', async () => {
    if (!confirm('Reset all impact stats? This cannot be undone.')) return;
    await resetStats();
    await refreshImpactSummary();
    els.saveState.textContent = 'Stats reset ✓';
    setTimeout(() => (els.saveState.textContent = ''), 1600);
  });
}

async function refreshImpactSummary() {
  try {
    const stats = await loadStats();
    const life = lifetimeSummary(stats);
    els.impactSummary.textContent =
      `All-time: ${life.duplicates} duplicates closed · ${life.restored} restored · ` +
      `${life.bulk} bulk-closed · ~${formatDuration(life.timeSavedSec)} saved`;
  } catch (err) {
    els.impactSummary.textContent = '';
  }
}

function addRuleRow(rule) {
  const node = ruleTpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.rule-match').value = rule.match || '';
  node.querySelector('.rule-category').value = rule.category || '';
  node.querySelector('.rule-emoji').value = rule.emoji || '';
  node.querySelector('.rule-remove').addEventListener('click', () => node.remove());
  els.userRules.appendChild(node);
}

function collectRules() {
  const rules = [];
  for (const row of els.userRules.querySelectorAll('.rule-row')) {
    const match = row.querySelector('.rule-match').value.trim();
    const category = row.querySelector('.rule-category').value.trim();
    const emoji = row.querySelector('.rule-emoji').value.trim();
    if (!match || !category) continue;
    rules.push({ match, category, emoji });
  }
  return rules;
}

async function persist() {
  settings.groupMode = els.groupMode.value;
  settings.showInternalPages = els.showInternal.checked;
  settings.staleEnabled = els.staleEnabled.checked;
  settings.staleDays = clampNumber(els.staleDays.value, 1, 60, 7);
  settings.userRules = collectRules();

  await saveSettings(settings);
  els.saveState.textContent = 'Saved ✓';
  setTimeout(() => (els.saveState.textContent = ''), 1600);
}

function clampNumber(raw, lo, hi, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
