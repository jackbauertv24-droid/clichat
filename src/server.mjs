// An OpenAI-compatible HTTP front end for the DeepSeek web backend.
//
// The impedance mismatch worth understanding: the OpenAI API is stateless (each
// request carries the entire `messages` array), while chat.deepseek.com is
// stateful (a chat_session_id plus a parent_message_id per turn). Recreating a
// session per request would discard the server-side conversation and resend the
// whole history as one prompt every time.
//
// So we keep a small LRU keyed by a hash of the conversation *prefix*. A client
// that appends to `messages` (which is what every OpenAI client does) hits the
// cache and we forward only the newest user message against the existing
// session. A cold key falls back to flattening the history into one prompt.

import { createServer as createHttpServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { DeepSeekError } from './client.mjs';

const MODELS = [
  { id: 'deepseek-chat', thinking: false, search: false },
  { id: 'deepseek-reasoner', thinking: true, search: false },
  { id: 'deepseek-chat-search', thinking: false, search: true },
  { id: 'deepseek-reasoner-search', thinking: true, search: true },
];

const modelConfig = (id) => MODELS.find((m) => m.id === id)
  // Unknown ids degrade to plain chat rather than 400ing, since many clients
  // hardcode names like "gpt-4o"; honour the r1/reasoner/search hints in them.
  ?? {
    id: id || 'deepseek-chat',
    thinking: /reason|r1|think/i.test(id || ''),
    search: /search/i.test(id || ''),
  };

const sha = (s) => createHash('sha256').update(s).digest('hex');
const keyOf = (messages) => sha(JSON.stringify(
  messages.map((m) => [m.role, contentToText(m.content)]),
));

// OpenAI allows content to be a string or an array of typed parts.
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p?.text ?? '')))
      .filter(Boolean)
      .join('');
  }
  return content == null ? '' : String(content);
}

// Renders a whole conversation as a single prompt, for a cold session.
export function flatten(messages) {
  const system = messages.filter((m) => m.role === 'system')
    .map((m) => contentToText(m.content)).filter(Boolean);
  const rest = messages.filter((m) => m.role !== 'system');

  const parts = [];
  if (system.length) parts.push(system.join('\n\n'));

  // A lone user turn needs no role labelling; anything longer does.
  if (rest.length === 1 && rest[0].role === 'user') {
    parts.push(contentToText(rest[0].content));
  } else {
    for (const m of rest) {
      const label = m.role === 'assistant' ? 'Assistant' : 'User';
      parts.push(`${label}: ${contentToText(m.content)}`);
    }
    parts.push('Assistant:');
  }
  return parts.join('\n\n').trim();
}

class ConversationCache {
  constructor(max = 200) { this.max = max; this.map = new Map(); }

  get(key) {
    const v = this.map.get(key);
    if (v) { this.map.delete(key); this.map.set(key, v); } // refresh LRU position
    return v;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

// Rough token estimate: the web backend reports no usage numbers, but many
// clients read these fields. Documented as an approximation, not a bill.
const estimate = (s) => Math.max(1, Math.ceil((s || '').length / 4));

function sendJson(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...cors(),
    ...extra,
  });
  res.end(payload);
}

const cors = () => ({
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
});

function sendError(res, status, message, type = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type, code: status } });
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer({ client, apiKey = null, log = () => {} } = {}) {
  const cache = new ConversationCache();

  async function completions(req, res, body) {
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages || messages.length === 0) {
      return sendError(res, 400, '"messages" must be a non-empty array');
    }
    const cfg = modelConfig(body.model);
    const stream = body.stream === true;
    const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);

    // Resume the session if this looks like an append to a known conversation.
    const prefixKey = keyOf(messages.slice(0, -1));
    const last = messages[messages.length - 1];
    const cached = messages.length > 1 ? cache.get(prefixKey) : null;

    let sessionId;
    let parentMessageId = null;
    let prompt;
    if (cached && last?.role === 'user') {
      ({ sessionId, parentMessageId } = cached);
      prompt = contentToText(last.content);
      log(`resume session ${String(sessionId).slice(0, 8)} (+1 message)`);
    } else {
      sessionId = await client.createSession();
      prompt = flatten(messages);
      log(`new session ${String(sessionId).slice(0, 8)} (${messages.length} messages)`);
    }

    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    const promptTokens = estimate(messages.map((m) => contentToText(m.content)).join(' '));
    let content = '';
    let reasoning = '';

    const upstream = client.stream({
      sessionId,
      parentMessageId,
      prompt,
      thinking: cfg.thinking,
      search: cfg.search,
      signal: abort.signal,
    });

    if (stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...cors(),
      });
      const chunk = (delta, finish = null) => {
        res.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: cfg.id,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`);
      };
      chunk({ role: 'assistant', content: '' });
      try {
        for await (const ev of upstream) {
          if (ev.type === 'message_id') { parentMessageId = ev.id; continue; }
          if (ev.type === 'thinking') { reasoning += ev.text; chunk({ reasoning_content: ev.text }); }
          else if (ev.type === 'content') { content += ev.text; chunk({ content: ev.text }); }
        }
        chunk({}, 'stop');
        res.write('data: [DONE]\n\n');
      } catch (err) {
        if (err?.name !== 'AbortError') {
          // Headers are already sent, so surface the failure inside the stream.
          res.write(`data: ${JSON.stringify({
            error: { message: err.message, type: 'upstream_error' },
          })}\n\n`);
        }
      } finally {
        res.end();
      }
    } else {
      try {
        for await (const ev of upstream) {
          if (ev.type === 'message_id') parentMessageId = ev.id;
          else if (ev.type === 'thinking') reasoning += ev.text;
          else if (ev.type === 'content') content += ev.text;
        }
      } catch (err) {
        if (err?.name === 'AbortError') return undefined;
        throw err;
      }
      const message = { role: 'assistant', content };
      if (reasoning) message.reasoning_content = reasoning;
      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: cfg.id,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: estimate(content + reasoning),
          total_tokens: promptTokens + estimate(content + reasoning),
        },
      });
    }

    // Record where this conversation now stands so the next append resumes it.
    if (content) {
      cache.set(keyOf([...messages, { role: 'assistant', content }]),
        { sessionId, parentMessageId });
    }
    return undefined;
  }

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') { res.writeHead(204, cors()); return res.end(); }

    if (apiKey) {
      const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (given !== apiKey) return sendError(res, 401, 'invalid api key', 'authentication_error');
    }

    if (path === '/v1/models' || path === '/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: MODELS.map((m) => ({
          id: m.id, object: 'model', created: 0, owned_by: 'deepseek',
        })),
      });
    }

    if (path === '/health') return sendJson(res, 200, { status: 'ok' });

    if (path === '/v1/chat/completions' || path === '/chat/completions') {
      if (req.method !== 'POST') return sendError(res, 405, 'method not allowed');
      let body;
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch (err) {
        return sendError(res, 400, `invalid JSON body: ${err.message}`);
      }
      try {
        return await completions(req, res, body);
      } catch (err) {
        log(`error: ${err.message}`);
        if (res.headersSent) { res.end(); return undefined; }
        const status = err instanceof DeepSeekError ? 502 : 500;
        return sendError(res, status, err.message, 'upstream_error');
      }
    }

    return sendError(res, 404, `unknown route ${path}`, 'not_found');
  });
}
