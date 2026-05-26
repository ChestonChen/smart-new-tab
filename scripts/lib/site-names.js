/**
 * Resolve a tab's "site name" — the friendly label we want to use as a group
 * title when grouping by domain. We prefer human-friendly names over raw
 * domains (YouTube vs youtube.com, Lark Docs vs docs.feishu.cn).
 */

const KNOWN = new Map([
  // social / video
  ['youtube.com', 'YouTube'],
  ['youtu.be', 'YouTube'],
  ['bilibili.com', 'Bilibili'],
  ['b23.tv', 'Bilibili'],
  ['twitch.tv', 'Twitch'],
  ['vimeo.com', 'Vimeo'],
  ['netflix.com', 'Netflix'],
  ['tiktok.com', 'TikTok'],
  ['douyin.com', '抖音'],

  // social
  ['twitter.com', 'Twitter'],
  ['x.com', 'X'],
  ['facebook.com', 'Facebook'],
  ['instagram.com', 'Instagram'],
  ['linkedin.com', 'LinkedIn'],
  ['reddit.com', 'Reddit'],
  ['threads.net', 'Threads'],
  ['weibo.com', '微博'],
  ['zhihu.com', '知乎'],
  ['xiaohongshu.com', '小红书'],

  // dev
  ['github.com', 'GitHub'],
  ['gitlab.com', 'GitLab'],
  ['bitbucket.org', 'Bitbucket'],
  ['code.byted.org', 'ByteCode'],
  ['stackoverflow.com', 'Stack Overflow'],
  ['stackexchange.com', 'Stack Exchange'],
  ['npmjs.com', 'npm'],
  ['pypi.org', 'PyPI'],
  ['crates.io', 'crates.io'],
  ['developer.mozilla.org', 'MDN'],
  ['devdocs.io', 'DevDocs'],
  ['codepen.io', 'CodePen'],
  ['codesandbox.io', 'CodeSandbox'],
  ['replit.com', 'Replit'],

  // AI
  ['openai.com', 'OpenAI'],
  ['chat.openai.com', 'ChatGPT'],
  ['chatgpt.com', 'ChatGPT'],
  ['claude.ai', 'Claude'],
  ['anthropic.com', 'Anthropic'],
  ['cursor.com', 'Cursor'],
  ['cursor.sh', 'Cursor'],
  ['huggingface.co', 'Hugging Face'],
  ['gemini.google.com', 'Gemini'],
  ['perplexity.ai', 'Perplexity'],
  ['arxiv.org', 'arXiv'],
  ['kaggle.com', 'Kaggle'],

  // docs / notes
  ['notion.so', 'Notion'],
  ['notion.site', 'Notion'],
  ['docs.google.com', 'Google Docs'],
  ['sheets.google.com', 'Google Sheets'],
  ['slides.google.com', 'Google Slides'],
  ['drive.google.com', 'Google Drive'],
  ['docs.feishu.cn', 'Feishu Docs'],
  ['docs.larksuite.com', 'Lark Docs'],
  ['feishu.cn', 'Feishu'],
  ['larksuite.com', 'Lark'],
  ['larkoffice.com', 'Lark'],
  ['confluence.com', 'Confluence'],
  ['atlassian.net', 'Atlassian'],
  ['yuque.com', '语雀'],
  ['obsidian.md', 'Obsidian'],

  // work / project
  ['jira.com', 'Jira'],
  ['linear.app', 'Linear'],
  ['asana.com', 'Asana'],
  ['trello.com', 'Trello'],
  ['clickup.com', 'ClickUp'],
  ['monday.com', 'Monday'],
  ['meego.byted.org', 'Meego'],
  ['meego.larkoffice.com', 'Meego'],
  ['meego.feishu.cn', 'Meego'],

  // communication
  ['slack.com', 'Slack'],
  ['discord.com', 'Discord'],
  ['mail.google.com', 'Gmail'],
  ['outlook.live.com', 'Outlook'],
  ['outlook.office.com', 'Outlook'],
  ['teams.microsoft.com', 'Teams'],
  ['zoom.us', 'Zoom'],
  ['meet.google.com', 'Google Meet'],

  // shopping
  ['amazon.com', 'Amazon'],
  ['taobao.com', '淘宝'],
  ['tmall.com', '天猫'],
  ['jd.com', '京东'],
  ['ebay.com', 'eBay'],

  // misc
  ['google.com', 'Google'],
  ['apple.com', 'Apple'],
  ['medium.com', 'Medium'],
  ['substack.com', 'Substack'],
  ['dev.to', 'DEV'],
  ['news.ycombinator.com', 'Hacker News'],
  ['producthunt.com', 'Product Hunt'],
  ['figma.com', 'Figma'],
  ['dribbble.com', 'Dribbble'],
  ['behance.net', 'Behance'],
  ['canva.com', 'Canva'],
  ['adobe.com', 'Adobe'],
]);

/**
 * Best-effort friendly site name for a tab.
 *   - Exact host hit > suffix hit > capitalize root label.
 */
export function siteNameFor(tab) {
  const host = (tab.host || '').toLowerCase();
  const root = (tab.rootDomain || '').toLowerCase();
  if (!host) return 'Unknown';

  if (KNOWN.has(host)) return KNOWN.get(host);
  if (KNOWN.has(root)) return KNOWN.get(root);

  // Walk parent suffixes: docs.foo.example.com → foo.example.com → example.com
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.');
    if (KNOWN.has(suffix)) return KNOWN.get(suffix);
  }

  // Fallback: take the label just before the TLD and Title-Case it.
  // "feishu-slide-library.example.com" → "Feishu Slide Library"
  const label = root ? root.split('.')[0] : host.split('.').slice(-2)[0];
  if (!label) return host;
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
