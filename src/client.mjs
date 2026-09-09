// Minimal client for the chat.deepseek.com private web API.
//
// This is the same endpoint set the browser SPA uses. It is not a public,
// documented API: DeepSeek can change it without notice, so every response
// shape is parsed defensively.

import { powHeader } from './pow.mjs';

const BASE = 'https://chat.deepseek.com';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';

export class DeepSeekError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class DeepSeekWebClient {
  constructor({ token, wafCookie, debug = false } = {}) {
    this.token = token;
    this.wafCookie = wafCookie;
    this.debug = debug;
  }

  headers(extra = {}) {
    const h = {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/json',
      origin: BASE,
      referer: `${BASE}/`,
      'user-agent': UA,
      'x-client-locale': 'en_US',
      'x-client-platform': 'web',
      'x-client-version': '1.3.0-auto-resume',
      ...extra,
    };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    // chat.deepseek.com sits behind AWS WAF. API paths normally answer without a
    // token, but if a challenge is being enforced the browser's cookie unblocks it.
    if (this.wafCookie) h.cookie = `aws-waf-token=${this.wafCookie}`;
    return h;
  }

  async post(path, body, extraHeaders) {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: this.headers(extraHeaders),
      body: JSON.stringify(body),
    });
    return res;
  }

  // Unwraps the {code,msg,data:{biz_data}} envelope the web API returns.
  async postJson(path, body, extraHeaders) {
    const res = await this.post(path, body, extraHeaders);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (text.includes('awsWafCookieDomainList') || text.includes('challenge.js')) {
        throw new DeepSeekError(
          'blocked by the AWS WAF bot challenge; supply a browser aws-waf-token '
          + 'cookie with `clichat auth --waf <token>`',
          { status: res.status },
        );
      }
      throw new DeepSeekError(
        `unexpected non-JSON reply from ${path} (HTTP ${res.status})`, { status: res.status },
      );
    }
    if (json.code && json.code !== 0) {
      throw new DeepSeekError(describeCode(json.code, json.msg), {
        code: json.code, status: res.status,
      });
    }
    return json?.data?.biz_data ?? json?.data ?? json;
  }

  async login({ email, password }) {
    const data = await this.postJson('/api/v0/users/login', {
      email,
      mobile: '',
      area_code: null,
      password,
      device_id: randomDeviceId(),
      os: 'web',
    });
    const token = data?.user?.token ?? data?.token;
    if (!token) throw new DeepSeekError('login succeeded but no token was returned');
    this.token = token;
    return token;
  }

  async createSession() {
    const data = await this.postJson('/api/v0/chat_session/create', { character_id: null });
    const id = data?.id ?? data?.chat_session_id;
    if (!id) throw new DeepSeekError('could not create a chat session');
    return id;
  }

  async powFor(targetPath) {
    const data = await this.postJson('/api/v0/chat/create_pow_challenge', {
      target_path: targetPath,
    });
    const challenge = data?.challenge ?? data;
    if (!challenge?.salt) throw new DeepSeekError('malformed proof-of-work challenge');
    return powHeader(challenge);
  }

  // Streams one completion. `onDelta({type, text})` is called with incremental
  // text; type is 'content' or 'thinking'. Resolves with the assembled turn.
  async *stream({ sessionId, parentMessageId = null, prompt, thinking = false, search = false }) {
    const target = '/api/v0/chat/completion';
    let res = await this.post(target, {
      chat_session_id: sessionId,
      parent_message_id: parentMessageId,
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinking,
      search_enabled: search,
    }, { 'x-ds-pow-response': await this.powFor(target) });

    // 40301 = stale/invalid PoW. Refresh the challenge and retry exactly once.
    if (!res.ok || (res.headers.get('content-type') || '').includes('application/json')) {
      const text = await res.text();
      let code;
      try { code = JSON.parse(text)?.code; } catch { /* not an envelope */ }
      if (code === 40301 || code === 40300) {
        res = await this.post(target, {
          chat_session_id: sessionId,
          parent_message_id: parentMessageId,
          prompt,
          ref_file_ids: [],
          thinking_enabled: thinking,
          search_enabled: search,
        }, { 'x-ds-pow-response': await this.powFor(target) });
      } else if (code) {
        throw new DeepSeekError(describeCode(code, JSON.parse(text)?.msg), { code });
      } else if (!res.ok) {
        throw new DeepSeekError(`HTTP ${res.status} from ${target}`, { status: res.status });
      } else {
        yield* parseSSE(streamOfString(text), this.debug);
        return;
      }
    }
    if (!res.ok) throw new DeepSeekError(`HTTP ${res.status} from ${target}`, { status: res.status });
    yield* parseSSE(res.body, this.debug);
  }
}

async function* streamOfString(s) { yield Buffer.from(s); }

// The web API has shipped two delta shapes: an OpenAI-ish choices/delta form and
// a path-addressed patch form ({v,p,o}). Handle both, ignore anything else.
export async function* parseSSE(body, debug = false) {
  const decoder = new TextDecoder();
  let buf = '';
  let lastPath = 'response/content';

  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      if (debug) process.stderr.write(`\x1b[2m<< ${payload}\x1b[0m\n`);

      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }

      const delta = ev?.choices?.[0]?.delta;
      if (delta) {
        if (delta.reasoning_content || delta.thinking_content) {
          yield { type: 'thinking', text: delta.reasoning_content ?? delta.thinking_content };
        }
        if (delta.content) yield { type: 'content', text: delta.content };
        if (ev.message_id) yield { type: 'message_id', id: ev.message_id };
        continue;
      }

      if ('v' in ev) {
        if (typeof ev.p === 'string' && ev.p) lastPath = ev.p;
        const path = typeof ev.p === 'string' && ev.p ? ev.p : lastPath;
        if (typeof ev.v === 'string') {
          if (path.endsWith('thinking_content')) yield { type: 'thinking', text: ev.v };
          else if (path.endsWith('content')) yield { type: 'content', text: ev.v };
        } else if (ev.v && typeof ev.v === 'object') {
          const r = ev.v.response ?? ev.v;
          if (typeof r?.thinking_content === 'string' && r.thinking_content) {
            yield { type: 'thinking', text: r.thinking_content };
          }
          if (typeof r?.content === 'string' && r.content) {
            yield { type: 'content', text: r.content };
          }
          const id = r?.message_id ?? ev.v.message_id;
          if (id) yield { type: 'message_id', id };
        }
      }
    }
  }
}

function describeCode(code, msg) {
  const known = {
    40002: 'missing token -- run `clichat auth` to sign in',
    40003: 'invalid or expired token -- run `clichat auth` again',
    40300: 'server rejected the request: proof-of-work header missing',
    40301: 'server rejected the proof-of-work answer',
  };
  return known[code] ?? `${msg || 'request failed'} (code ${code})`;
}

function randomDeviceId() {
  return Array.from({ length: 32 },
    () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
}
