// The HTTP surface for the web view.
//
// This endpoint causes files to be written, so it is guarded harder than
// `serve`, which only spends quota:
//
//   - it binds loopback, and a non-local host is refused outright. There is no
//     --api-key style escape hatch, because the blast radius is your disk;
//   - a token is minted per run. It rides in the URL *fragment*, which browsers
//     never send to a server, so it stays out of request lines, logs and
//     Referer headers. The page reads it from its own location and puts it back
//     on the requests that need it;
//   - POSTs -- the two routes that can do anything -- require the token in an
//     `x-clichat-token` header. A custom header cannot be sent cross-origin
//     without a successful preflight, and no route answers one, so a hostile
//     page in another tab cannot drive the agent even if it guesses the port;
//   - no CORS headers are sent at all. `serve` is meant to be called by other
//     tools; this is not;
//   - the Host header is checked, which is what stops DNS rebinding turning a
//     public name into a loopback request.
//
// GET / is deliberately open: it is an inert document that does nothing without
// a token, and the fragment cannot be read until after it loads.

import { createServer as createHttpServer } from 'node:http';
import { sendJson, sendError, readBody } from './http.mjs';
import { page } from './webpage.mjs';

const HEARTBEAT_MS = 25_000;

export const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const isLocalHost = (host) => LOCAL_HOSTS.has(String(host ?? '').trim());

// The Host header carries a port; the name in front of it is what matters.
function hostAllowed(header) {
  const raw = String(header ?? '').trim();
  if (!raw) return false;
  const name = raw.startsWith('[')
    ? raw.slice(0, raw.indexOf(']') + 1)      // [::1]:8787
    : raw.split(':')[0];
  return isLocalHost(name);
}

export function createWebServer({ hub, token, log = () => {} }) {
  if (!token) throw new Error('the web view needs a token');
  const clients = new Set();

  hub.attach((event) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  });

  function events(req, res, url) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    // Join the fan-out BEFORE replaying. The rest of this function is
    // synchronous, so nothing can interleave -- whereas registering afterwards
    // leaves a window in which an event is emitted, goes to nobody, and is
    // never seen again, because the client has no reason to reconnect.
    clients.add(res);

    const since = Number(url.searchParams.get('since'));
    res.write(`data: ${JSON.stringify(hub.status())}\n\n`);
    for (const e of hub.since(Number.isFinite(since) ? since : 0)) {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    }
    const beat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, HEARTBEAT_MS);
    beat.unref?.();

    const drop = () => { clearInterval(beat); clients.delete(res); };
    req.on('close', drop);
    req.on('error', drop);
  }

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (!hostAllowed(req.headers.host)) {
      return sendError(res, 403, 'this server only answers on localhost', 'forbidden');
    }
    // No CORS is granted, so a preflight must fail rather than be answered.
    if (req.method === 'OPTIONS') return sendError(res, 405, 'method not allowed');

    if (path === '/health') return sendJson(res, 200, { status: 'ok' });

    if (path === '/') {
      if (req.method !== 'GET') return sendError(res, 405, 'method not allowed');
      const body = page();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      return res.end(body);
    }

    if (path === '/events') {
      if (url.searchParams.get('token') !== token) {
        return sendError(res, 401, 'invalid token', 'authentication_error');
      }
      return events(req, res, url);
    }

    if (path === '/task' || path === '/answer') {
      if (req.method !== 'POST') return sendError(res, 405, 'method not allowed');
      // Header, not body: a custom header is what a cross-origin page cannot set.
      if (req.headers['x-clichat-token'] !== token) {
        return sendError(res, 401, 'invalid token', 'authentication_error');
      }
      let body;
      try {
        body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}');
      } catch (err) {
        return sendError(res, 400, `invalid JSON body: ${err.message}`);
      }

      if (path === '/task') {
        const text = String(body?.text ?? '').trim();
        if (!text) return sendError(res, 400, '"text" is required');
        hub.submit(text, 'web');
        log(`task from the web: ${text.split('\n')[0].slice(0, 60)}`);
        return sendJson(res, 202, { queued: true });
      }

      const settled = hub.answer(String(body?.id ?? ''), !!body?.ok, 'web');
      return sendJson(res, settled ? 200 : 409, { settled });
    }

    return sendError(res, 404, `unknown route ${path}`, 'not_found');
  });

  server.on('close', () => { for (const res of clients) { try { res.end(); } catch { /* gone */ } } });
  return server;
}
