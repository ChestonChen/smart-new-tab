#!/usr/bin/env node
/**
 * cursor-llm-proxy
 * ----------------
 * A tiny localhost-only HTTP server that exposes an OpenAI-compatible
 * `POST /v1/chat/completions` endpoint and fulfils every request by shelling
 * out to `cursor-agent` in headless mode. This lets the Smart New Tab
 * extension (or any other OpenAI-shaped client) use your already-logged-in
 * Cursor account for inference — no API key required.
 *
 * Zero dependencies: pure Node 18+ (`http`, `child_process`).
 *
 * Usage:
 *   node server.js                  # default port 8788, default model sonnet-4
 *   PORT=9000 MODEL=gpt-5 node server.js
 *
 * Endpoints:
 *   GET  /health                    # liveness probe
 *   POST /v1/chat/completions       # OpenAI Chat Completions, sync only
 *   GET  /v1/models                 # static list (compat with some clients)
 *
 * Notes:
 *   - Binds to 127.0.0.1 only.
 *   - Requests are processed FIFO (cursor-agent is heavy; no parallelism).
 *   - Default per-request timeout: 90s.
 *   - Streaming (`stream: true`) is not supported; the proxy will return
 *     a non-streaming reply and the client must tolerate it.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8788);
const HOST = '127.0.0.1';
const DEFAULT_MODEL = process.env.MODEL || 'sonnet-4';
const CURSOR_AGENT_BIN = process.env.CURSOR_AGENT_BIN || 'cursor-agent';
const REQUEST_TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 90_000);
const WORKSPACE = process.env.WORKSPACE_DIR || process.cwd();

// ---------- request queue (sequential, cursor-agent isn't cheap) ----------

let queue = Promise.resolve();
function enqueue(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

// ---------- cursor-agent invocation -----------------------------------------

function runCursorAgent({ prompt, model, signal }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--mode', 'ask',
      '--trust',
      '--model', model,
      '--workspace', WORKSPACE,
      prompt,
    ];

    const child = spawn(CURSOR_AGENT_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });

    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code !== 0) {
        return reject(new Error(`cursor-agent exited ${code}: ${stderr.trim() || stdout.trim()}`));
      }
      try {
        const envelope = JSON.parse(stdout.trim());
        if (envelope?.is_error || envelope?.subtype !== 'success') {
          return reject(new Error(`cursor-agent error envelope: ${JSON.stringify(envelope).slice(0, 400)}`));
        }
        resolve({
          content: typeof envelope.result === 'string' ? envelope.result : JSON.stringify(envelope.result),
          usage: envelope.usage || null,
          durationMs: envelope.duration_ms ?? null,
          sessionId: envelope.session_id || null,
        });
      } catch (e) {
        reject(new Error(`cursor-agent JSON parse failed: ${e.message}; raw=${stdout.slice(0, 400)}`));
      }
    });
  });
}

// ---------- prompt assembly --------------------------------------------------

function messagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }
  const systems = messages.filter((m) => m.role === 'system').map((m) => stringContent(m.content));
  const users = messages.filter((m) => m.role === 'user').map((m) => stringContent(m.content));
  if (users.length === 0) throw new Error('at least one user message is required');

  const sys = systems.join('\n\n').trim();
  const usr = users.join('\n\n').trim();
  return sys ? `${sys}\n\n---\n\n${usr}` : usr;
}

function stringContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).filter(Boolean).join('\n');
  }
  return '';
}

// ---------- http server ------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...headers,
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      buf += c.toString('utf8');
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('invalid JSON body: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  log(`<-- ${req.method} ${req.url}`);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, model: DEFAULT_MODEL, queueDepth: queueDepth() });
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    return send(res, 200, {
      object: 'list',
      data: [
        { id: 'sonnet-4', object: 'model', created: 0, owned_by: 'cursor' },
        { id: 'sonnet-4-thinking', object: 'model', created: 0, owned_by: 'cursor' },
        { id: 'gpt-5', object: 'model', created: 0, owned_by: 'cursor' },
      ],
    });
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, 400, { error: { message: e.message, type: 'invalid_request_error' } });
    }
    try {
      const prompt = messagesToPrompt(body.messages);
      const model = body.model && typeof body.model === 'string' ? body.model : DEFAULT_MODEL;

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
      req.on('close', () => ac.abort());

      const result = await enqueue(() => runCursorAgent({ prompt, model, signal: ac.signal }));
      clearTimeout(timer);

      const id = 'chatcmpl-' + randomUUID();
      const payload = {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.content },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: result.usage?.inputTokens ?? 0,
          completion_tokens: result.usage?.outputTokens ?? 0,
          total_tokens:
            (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        },
        _cursor: {
          session_id: result.sessionId,
          duration_ms: result.durationMs,
        },
      };
      log(`--> 200  ${Date.now() - t0}ms  model=${model}  session=${result.sessionId || '-'}`);
      return send(res, 200, payload);
    } catch (e) {
      log(`--> 500  ${Date.now() - t0}ms  err=${e.message}`);
      return send(res, 500, { error: { message: e.message, type: 'cursor_agent_error' } });
    }
  }

  return send(res, 404, { error: { message: 'not found', type: 'not_found' } });
});

function queueDepth() {
  // Heuristic: we can't introspect chained promises cheaply, so this is a
  // rough proxy. Surfaced only for /health.
  return queue === Promise.resolve() ? 0 : 1;
}

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${t}] ${msg}\n`);
}

server.listen(PORT, HOST, () => {
  log(`cursor-llm-proxy listening on http://${HOST}:${PORT}`);
  log(`  model     = ${DEFAULT_MODEL}`);
  log(`  binary    = ${CURSOR_AGENT_BIN}`);
  log(`  workspace = ${WORKSPACE}`);
  log(`  timeout   = ${REQUEST_TIMEOUT_MS}ms`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}
