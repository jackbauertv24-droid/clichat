import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SessionHub } from '../src/hub.mjs';
import { createWebServer, isLocalHost } from '../src/webui.mjs';
import { request } from 'node:http';

// fetch() refuses to set a Host header -- it is a forbidden header name and is
// dropped silently -- so the rebinding guard has to be probed with a raw client.
const rawGet = (path, host) => new Promise((resolve, reject) => {
  const req = request(
    { host: '127.0.0.1', port: server.address().port, path, headers: { host } },
    (res) => { res.resume(); resolve(res.statusCode); },
  );
  req.on('error', reject);
  req.end();
});

// Reads `want` SSE frames, tolerating chunk boundaries anywhere.
async function readFrames(res, want) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const frames = [];
  let buf = '';
  while (frames.length < want) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let at;
    while ((at = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, at);
      buf = buf.slice(at + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
      }
    }
  }
  await reader.cancel();
  return frames;
}

const TOKEN = 'test-token-0123456789';
let hub;
let server;
let base;

before(async () => {
  hub = new SessionHub({ root: '/work', run: async () => {} });
  server = createWebServer({ hub, token: TOKEN });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const auth = { 'x-clichat-token': TOKEN };

// ------------------------------------------------------------------ the page

test('the page is served, and does not contain the token', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const html = await r.text();
  assert.match(html, /clichat code/);
  assert.equal(html.includes(TOKEN), false, 'the token was baked into the page');
});

test('the page sends no referrer, so a token fragment cannot leak onward', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('no CORS is granted anywhere -- this is not an API for other tools', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('a preflight is refused rather than answered', async () => {
  const r = await fetch(`${base}/task`, { method: 'OPTIONS' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

// -------------------------------------------------------------------- tokens

test('POST /task without the token is refused', async () => {
  const r = await post('/task', { text: 'do a thing' });
  assert.equal(r.status, 401);
});

test('POST /task with the token in the BODY is still refused', async () => {
  // The header is the point: a cross-origin page can set a body, not a header.
  const r = await post('/task', { text: 'do a thing', token: TOKEN });
  assert.equal(r.status, 401);
});

test('POST /task with a wrong token is refused', async () => {
  const r = await post('/task', { text: 'x' }, { 'x-clichat-token': 'nope' });
  assert.equal(r.status, 401);
});

test('GET /events without the token is refused', async () => {
  const r = await fetch(`${base}/events`);
  assert.equal(r.status, 401);
  await r.text();
});

test('a foreign Host header is refused, which is what stops DNS rebinding', async () => {
  assert.equal(await rawGet('/health', 'evil.example.com'), 403);
  assert.equal(await rawGet('/', 'evil.example.com'), 403);
});

test('a Host of localhost, with or without a port, is fine', async () => {
  assert.equal(await rawGet('/health', 'localhost:8787'), 200);
  assert.equal(await rawGet('/health', '127.0.0.1'), 200);
  assert.equal(await rawGet('/health', '[::1]:8787'), 200);
});

// --------------------------------------------------------------------- tasks

test('POST /task with the token queues the task', async () => {
  const seen = [];
  const off = hub.attach((e) => seen.push(e));
  const r = await post('/task', { text: 'build the thing' }, auth);
  assert.equal(r.status, 202);
  await hub.settled();
  off();
  assert.ok(seen.find((e) => e.type === 'task' && e.text === 'build the thing' && e.by === 'web'));
});

test('an empty task is rejected', async () => {
  assert.equal((await post('/task', { text: '   ' }, auth)).status, 400);
});

test('a malformed body is a 400, not a crash', async () => {
  const r = await fetch(`${base}/task`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: '{oh no',
  });
  assert.equal(r.status, 400);
});

test('POST /answer settles an outstanding approval', async () => {
  const seen = [];
  const off = hub.attach((e) => seen.push(e));
  const pending = hub.askApproval('write a.txt');
  const { id } = seen.find((e) => e.type === 'ask');

  const r = await post('/answer', { id, ok: true }, auth);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { settled: true });
  assert.equal(await pending, true);
  off();
});

test('answering something already settled reports a conflict', async () => {
  const r = await post('/answer', { id: 'gone', ok: true }, auth);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { settled: false });
});

test('an unknown route is a 404', async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

// ----------------------------------------------------------------------- SSE

test('/events streams well-formed frames, starting with status', async () => {
  // Its own hub, so the replay is empty and the live frame is the second one.
  const fresh = new SessionHub({ root: '/work', run: async () => {} });
  const s2 = createWebServer({ hub: fresh, token: TOKEN });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));

  const r = await fetch(`http://127.0.0.1:${s2.address().port}/events?token=${TOKEN}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);

  fresh.emit({ type: 'prose', text: 'streamed' });

  const frames = await readFrames(r, 2);
  s2.close();

  assert.equal(frames[0].type, 'status');
  assert.equal(frames[0].root, '/work');
  assert.ok(frames.find((f) => f.type === 'prose' && f.text === 'streamed'));
});

test('an event emitted the instant a client joins is not lost', async () => {
  // The window this closes: registering the client after writing the replay
  // meant an event landing in between went to nobody and never came back.
  const fresh = new SessionHub({ root: '/work', run: async () => {} });
  const s2 = createWebServer({ hub: fresh, token: TOKEN });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));

  const pending = fetch(`http://127.0.0.1:${s2.address().port}/events?token=${TOKEN}`);
  fresh.emit({ type: 'prose', text: 'right-on-the-boundary' });
  const r = await pending;
  const frames = await readFrames(r, 2);
  s2.close();

  assert.ok(frames.find((f) => f.text === 'right-on-the-boundary'));
});

test('a reconnect replays only what it missed', async () => {
  const fresh = new SessionHub({ root: '/work', run: async () => {} });
  const s2 = createWebServer({ hub: fresh, token: TOKEN });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;

  fresh.emit({ type: 'prose', text: 'one' });
  fresh.emit({ type: 'prose', text: 'two' });
  fresh.emit({ type: 'prose', text: 'three' });

  const r = await fetch(`${b2}/events?token=${TOKEN}&since=2`);
  const reader = r.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  await reader.cancel();
  s2.close();

  assert.match(text, /"type":"status"/);
  assert.equal(/"text":"one"/.test(text), false, 'replayed an event the client already had');
  assert.match(text, /"text":"three"/);
});

// -------------------------------------------------------------------- guards

test('isLocalHost accepts loopback names only', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1']) assert.equal(isLocalHost(h), true);
  for (const h of ['0.0.0.0', '192.168.1.5', 'example.com', '']) assert.equal(isLocalHost(h), false);
});

test('a server cannot be created without a token', () => {
  assert.throws(() => createWebServer({ hub, token: '' }), /needs a token/);
});
