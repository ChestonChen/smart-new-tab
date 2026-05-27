/**
 * Optional LLM-based tab classifier.
 *
 * Privacy contract:
 *   - Only `host` + `title` are sent. Full URLs (which may contain auth
 *     tokens or query strings) are never transmitted.
 *   - Nothing is sent unless settings.llm.enabled === true AND an
 *     endpoint + apiKey are configured (Ollama is exempt from apiKey).
 *
 * The function takes a list of tabs and a settings object, and returns
 *   {
 *     overrides: Map<tabId, { category: string, emoji?: string }>,
 *     status:    'ok' | 'disabled' | 'empty' | 'offline' | 'parse-error',
 *   }
 *
 *   - 'ok'          — LLM responded and at least one tab got tagged
 *   - 'disabled'    — settings.llm.enabled was false; nothing tried
 *   - 'empty'       — no tabs to classify
 *   - 'offline'     — fetch threw (proxy unreachable, DNS fail, etc.)
 *   - 'parse-error' — LLM responded but reply wasn't a usable JSON shape
 */

const SYSTEM_PROMPT = `You are an assistant that groups browser tabs into short, intuitive categories.
Goal: cluster tabs so that the user can quickly see what they were working on across windows.
Rules:
- Output STRICT JSON only, no prose, no markdown fences.
- Each category label must be at most 3 words and human-friendly (e.g. "Research", "Project: Auth", "React Server Components").
- Prefer 4 to 8 distinct categories total. Don't dump everything into "Other".
- Tabs sharing a project/topic should share a category even if their domains differ.
- Tabs on the same domain serving different topics should split into different categories.`;

const USER_TEMPLATE = (tabs) => `Tabs (id | host | title):
${tabs.map((t) => `${t.id} | ${t.host} | ${(t.title || '').slice(0, 140)}`).join('\n')}

Return JSON of shape:
{
  "categories": [
    { "name": "...", "emoji": "📁", "tab_ids": [1, 2, 3] }
  ]
}`;

export async function classifyTabsWithLLM(tabs, llmConfig) {
  if (!llmConfig?.enabled) return { overrides: new Map(), status: 'disabled' };
  if (!tabs || tabs.length === 0) return { overrides: new Map(), status: 'empty' };

  const compactTabs = tabs.map((t) => ({ id: t.id, host: t.host, title: t.title }));

  let response;
  try {
    response = await callProvider(llmConfig, compactTabs);
  } catch (err) {
    console.warn('[smart-new-tab] LLM offline, falling back to heuristics:', err);
    return { overrides: new Map(), status: 'offline' };
  }

  const overrides = parseLLMResponse(response, tabs);
  if (overrides.size === 0) {
    return { overrides, status: 'parse-error' };
  }
  return { overrides, status: 'ok' };
}

async function callProvider(cfg, compactTabs) {
  const userMsg = USER_TEMPLATE(compactTabs);
  switch (cfg.provider) {
    case 'openai':
      return callOpenAI(cfg, userMsg);
    case 'anthropic':
      return callAnthropic(cfg, userMsg);
    case 'ollama':
      return callOllama(cfg, userMsg);
    case 'custom':
      return callCustom(cfg, userMsg);
    default:
      throw new Error('Unknown provider: ' + cfg.provider);
  }
}

async function callOpenAI(cfg, userMsg) {
  if (!cfg.apiKey) throw new Error('Missing OpenAI apiKey');
  return callOpenAICompatible(cfg, userMsg, {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    requireApiKey: true,
  });
}

async function callOpenAICompatible(cfg, userMsg, defaults) {
  const endpoint = cfg.endpoint || defaults.endpoint;
  const model = cfg.model || defaults.model;
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  else if (defaults.requireApiKey) throw new Error('Missing apiKey');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic(cfg, userMsg) {
  if (!cfg.apiKey) throw new Error('Missing Anthropic apiKey');
  const endpoint = cfg.endpoint || 'https://api.anthropic.com/v1/messages';
  const model = cfg.model || 'claude-3-5-haiku-latest';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

async function callOllama(cfg, userMsg) {
  const endpoint = cfg.endpoint || 'http://localhost:11434/api/chat';
  const model = cfg.model || 'llama3.2';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.message?.content || '';
}

async function callCustom(cfg, userMsg) {
  if (!cfg.endpoint) throw new Error('Missing custom endpoint');
  // OpenAI-compatible shape; apiKey is optional for local proxies
  // (e.g. cursor-llm-proxy) that don't need a key.
  return callOpenAICompatible(cfg, userMsg, {
    endpoint: cfg.endpoint,
    model: cfg.model || 'sonnet-4',
    requireApiKey: false,
  });
}

function parseLLMResponse(text, tabs) {
  const result = new Map();
  if (!text) return result;
  // Strip code fences just in case.
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let json;
  try {
    json = JSON.parse(cleaned);
  } catch {
    return result;
  }
  const cats = Array.isArray(json.categories) ? json.categories : [];
  const validIds = new Set(tabs.map((t) => t.id));
  for (const c of cats) {
    const name = String(c?.name || '').trim();
    if (!name) continue;
    const emoji = String(c?.emoji || '').trim() || '✨';
    const ids = Array.isArray(c?.tab_ids) ? c.tab_ids : [];
    for (const id of ids) {
      if (validIds.has(id)) result.set(id, { category: name, emoji });
    }
  }
  return result;
}
