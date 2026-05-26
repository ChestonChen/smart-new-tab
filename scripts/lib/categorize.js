/**
 * Categorize tabs by domain + title heuristics.
 *
 * The result is deterministic and offline. An optional LLM pass can
 * be layered on top (see scripts/lib/llm.js) and replaces the heuristic
 * label for tabs the LLM has high confidence in.
 */

const RAW_RULES = [
  {
    id: 'dev',
    label: 'Development',
    emoji: '💻',
    domains: [
      'github.com', 'gitlab.com', 'bitbucket.org', 'code.byted.org',
      'stackoverflow.com', 'stackexchange.com', 'npmjs.com', 'pypi.org',
      'crates.io', 'pkg.go.dev', 'docker.com', 'docker.io', 'kubernetes.io',
      'devdocs.io', 'developer.mozilla.org', 'mdn.io',
      'jetbrains.com', 'vercel.com', 'netlify.com', 'cloudflare.com',
      'replit.com', 'codesandbox.io', 'codepen.io',
    ],
    keywords: ['github', 'gitlab', 'merge request', 'pull request', 'commit', 'stack overflow', 'docker', 'kubernetes'],
  },
  {
    id: 'ai',
    label: 'AI & Research',
    emoji: '🤖',
    domains: [
      'openai.com', 'chat.openai.com', 'chatgpt.com', 'anthropic.com',
      'claude.ai', 'cursor.com', 'cursor.sh', 'huggingface.co',
      'arxiv.org', 'paperswithcode.com', 'kaggle.com', 'gemini.google.com',
      'perplexity.ai', 'ollama.ai', 'replicate.com', 'mistral.ai',
    ],
    keywords: ['gpt', 'claude', 'llm', 'embedding', 'transformer', 'arxiv'],
  },
  {
    id: 'docs',
    label: 'Docs & Notes',
    emoji: '📝',
    domains: [
      'notion.so', 'notion.site', 'confluence.com', 'atlassian.net',
      'docs.google.com', 'feishu.cn', 'larksuite.com', 'lark.com',
      'larkoffice.com', 'wolai.com', 'yuque.com', 'quip.com',
      'dropbox.com/paper', 'evernote.com', 'obsidian.md',
    ],
    keywords: ['doc -', '- docs', 'notion', 'notes', 'wiki'],
  },
  {
    id: 'work',
    label: 'Work & Project',
    emoji: '🏢',
    domains: [
      'jira.com', 'atlassian.com', 'asana.com', 'trello.com',
      'linear.app', 'monday.com', 'clickup.com', 'basecamp.com',
      'meego.byted.org', 'meego.larkoffice.com', 'meego.feishu.cn',
      'tower.im', 'teambition.com',
    ],
    keywords: ['jira', 'ticket', 'meego', '[bug]', 'sprint', 'roadmap'],
  },
  {
    id: 'comm',
    label: 'Communication',
    emoji: '💬',
    domains: [
      'slack.com', 'discord.com', 'discord.gg', 'mail.google.com',
      'outlook.live.com', 'outlook.office.com', 'mail.feishu.cn',
      'mail.larkoffice.com', 'teams.microsoft.com', 'zoom.us',
      'meet.google.com', 'webex.com',
    ],
    keywords: ['inbox', 'mail', 'meeting', 'zoom', 'slack'],
  },
  {
    id: 'video',
    label: 'Video',
    emoji: '🎬',
    domains: [
      'youtube.com', 'youtu.be', 'bilibili.com', 'b23.tv',
      'vimeo.com', 'twitch.tv', 'netflix.com', 'disneyplus.com',
      'iqiyi.com', 'youku.com', 'tiktok.com', 'douyin.com',
    ],
    keywords: ['watch -', 'episode', '- youtube'],
  },
  {
    id: 'social',
    label: 'Social',
    emoji: '🗣️',
    domains: [
      'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
      'linkedin.com', 'reddit.com', 'weibo.com', 'zhihu.com',
      'xiaohongshu.com', 'mastodon.social', 'threads.net',
    ],
    keywords: ['reddit', 'twitter', 'zhihu'],
  },
  {
    id: 'shopping',
    label: 'Shopping',
    emoji: '🛒',
    domains: [
      'amazon.com', 'amazon.cn', 'amazon.co.uk', 'amazon.co.jp',
      'taobao.com', 'tmall.com', 'jd.com', 'pinduoduo.com',
      'ebay.com', 'shopify.com', 'shopee.com', 'lazada.com',
      'apple.com/shop',
    ],
    keywords: ['cart', 'checkout', 'shopping'],
  },
  {
    id: 'finance',
    label: 'Finance',
    emoji: '💰',
    domains: [
      'tradingview.com', 'investing.com', 'yahoo.com/finance',
      'coingecko.com', 'coinmarketcap.com', 'binance.com',
      'okx.com', 'bloomberg.com', 'cnbc.com', 'wsj.com',
    ],
    keywords: ['stock', 'crypto', 'price', 'market'],
  },
  {
    id: 'news',
    label: 'News & Reading',
    emoji: '📰',
    domains: [
      'medium.com', 'substack.com', 'dev.to', 'hackernews.com',
      'news.ycombinator.com', 'theverge.com', 'techcrunch.com',
      'wired.com', 'nytimes.com', 'bbc.com', 'reuters.com',
      'sspai.com', 'ifanr.com',
    ],
    keywords: ['hacker news', 'medium', 'blog'],
  },
  {
    id: 'design',
    label: 'Design',
    emoji: '🎨',
    domains: [
      'figma.com', 'sketch.com', 'framer.com', 'invisionapp.com',
      'dribbble.com', 'behance.net', 'pinterest.com', 'canva.com',
      'adobe.com',
    ],
    keywords: ['figma', 'design', 'dribbble'],
  },
  {
    id: 'cloud',
    label: 'Cloud & Infra',
    emoji: '☁️',
    domains: [
      'aws.amazon.com', 'console.aws.amazon.com', 'cloud.google.com',
      'console.cloud.google.com', 'azure.microsoft.com',
      'portal.azure.com', 'datadoghq.com', 'newrelic.com',
      'pagerduty.com', 'sentry.io',
    ],
    keywords: ['aws', 'gcp', 'azure', 'datadog', 'sentry'],
  },
];

const OTHER = { id: 'other', label: 'Other', emoji: '📂' };

const DOMAIN_INDEX = (() => {
  const m = new Map();
  for (const r of RAW_RULES) {
    for (const d of r.domains) m.set(d.toLowerCase(), r);
  }
  return m;
})();

function matchByDomain(tab) {
  const host = (tab.host || '').toLowerCase();
  if (!host) return null;
  // try exact + walk suffixes
  if (DOMAIN_INDEX.has(host)) return DOMAIN_INDEX.get(host);
  for (const [d, rule] of DOMAIN_INDEX) {
    if (host === d || host.endsWith('.' + d)) return rule;
    // domain entries that include a path suffix (e.g. "yahoo.com/finance")
    if (d.includes('/')) {
      const [pureDom, ...rest] = d.split('/');
      const pathFrag = '/' + rest.join('/');
      if ((host === pureDom || host.endsWith('.' + pureDom)) && tab.path.startsWith(pathFrag)) {
        return rule;
      }
    }
  }
  return null;
}

function matchByKeyword(tab) {
  const hay = `${tab.title || ''} ${tab.host || ''}`.toLowerCase();
  for (const r of RAW_RULES) {
    for (const kw of r.keywords) {
      if (hay.includes(kw)) return r;
    }
  }
  return null;
}

/**
 * Apply user-defined overrides from settings.
 * Each entry: { match: "host or substring", category: "id-or-new-label", emoji?: "..." }
 */
function matchByUserRule(tab, userRules) {
  if (!userRules || userRules.length === 0) return null;
  const hay = `${tab.host || ''} ${tab.url} ${tab.title || ''}`.toLowerCase();
  for (const rule of userRules) {
    const needle = (rule.match || '').toLowerCase().trim();
    if (!needle) continue;
    if (hay.includes(needle)) {
      const id = (rule.category || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'user';
      return {
        id: 'user:' + id,
        label: rule.category || 'User',
        emoji: rule.emoji || '⭐',
      };
    }
  }
  return null;
}

/**
 * @param {Array} tabs
 * @param {{ userRules?: Array }} opts
 * @returns {Map<string, {info: Category, items: Array}>}
 */
export function categorizeHeuristic(tabs, { userRules = [] } = {}) {
  const groups = new Map();
  const ensure = (info) => {
    if (!groups.has(info.id)) groups.set(info.id, { info, items: [] });
    return groups.get(info.id);
  };

  for (const t of tabs) {
    const rule =
      matchByUserRule(t, userRules) ||
      matchByDomain(t) ||
      matchByKeyword(t) ||
      OTHER;
    ensure({ id: rule.id, label: rule.label, emoji: rule.emoji }).items.push(t);
  }

  // sort groups: larger first, "Other" always last
  return new Map(
    [...groups.entries()].sort(([aId, a], [bId, b]) => {
      if (aId === 'other') return 1;
      if (bId === 'other') return -1;
      return b.items.length - a.items.length;
    }),
  );
}

/**
 * Merge LLM-derived category overrides on top of heuristic groups.
 * `overrides` is `Map<tabId, { category: string, emoji?: string }>`.
 */
export function applyLLMOverrides(heuristicGroups, tabs, overrides) {
  if (!overrides || overrides.size === 0) return heuristicGroups;

  // Build new grouping: tab-level remap.
  const final = new Map();
  const ensure = (info) => {
    if (!final.has(info.id)) final.set(info.id, { info, items: [] });
    return final.get(info.id);
  };

  // Find heuristic label of a given tab id (fallback if LLM didn't tag it).
  const tabHeuristic = new Map();
  for (const [, g] of heuristicGroups) {
    for (const t of g.items) tabHeuristic.set(t.id, g.info);
  }

  for (const t of tabs) {
    const ov = overrides.get(t.id);
    const info = ov
      ? {
          id: 'ai:' + (ov.category || 'misc').toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
          label: ov.category || 'AI Group',
          emoji: ov.emoji || '✨',
        }
      : tabHeuristic.get(t.id) || OTHER;
    ensure(info).items.push(t);
  }

  return new Map(
    [...final.entries()].sort(([aId, a], [bId, b]) => {
      if (aId === 'other') return 1;
      if (bId === 'other') return -1;
      return b.items.length - a.items.length;
    }),
  );
}

export const HEURISTIC_RULES = RAW_RULES;
export const OTHER_CATEGORY = OTHER;
