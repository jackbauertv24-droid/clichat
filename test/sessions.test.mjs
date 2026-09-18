import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the config directory somewhere disposable before importing the module
// under test, so nothing here touches the real ~/.config/clichat.
const HOME = mkdtempSync(join(tmpdir(), 'clichat-cfg-'));
process.env.XDG_CONFIG_HOME = HOME;

const {
  rememberSession, recallSession, forgetSession, listSessions, loadSessions, sessionsPath,
} = await import('../src/sessions.mjs');

beforeEach(() => { if (existsSync(sessionsPath)) rmSync(sessionsPath); });
after(() => rmSync(HOME, { recursive: true, force: true }));

test('nothing is remembered to begin with', () => {
  assert.equal(recallSession('/work'), null);
  assert.deepEqual(listSessions(), []);
});

test('a session is remembered and recalled for its own workspace', () => {
  rememberSession('/work', { sessionId: 's1', parentMessageId: 42, label: 'add a flag' });
  const r = recallSession('/work');
  assert.equal(r.sessionId, 's1');
  assert.equal(r.parentMessageId, 42);
  assert.equal(r.label, 'add a flag');
  assert.ok(Date.parse(r.updated) > 0);
});

test('workspaces do not see each other', () => {
  rememberSession('/a', { sessionId: 'sa' });
  rememberSession('/b', { sessionId: 'sb' });
  assert.equal(recallSession('/a').sessionId, 'sa');
  assert.equal(recallSession('/b').sessionId, 'sb');
  assert.equal(recallSession('/c'), null);
});

test('the pointer advances as the conversation does', () => {
  rememberSession('/work', { sessionId: 's1', parentMessageId: 1, label: 'first task' });
  rememberSession('/work', { sessionId: 's1', parentMessageId: 9, label: 'a later task' });
  const r = recallSession('/work');
  assert.equal(r.parentMessageId, 9);
  assert.equal(r.label, 'first task', 'the label should name what the session set out to do');
});

test('a genuinely new session takes a new label', () => {
  rememberSession('/work', { sessionId: 's1', label: 'first task' });
  rememberSession('/work', { sessionId: 's2', label: 'a fresh start' });
  assert.equal(recallSession('/work').label, 'a fresh start');
});

test('a long label is trimmed and flattened to one line', () => {
  rememberSession('/work', { sessionId: 's1', label: `a\n  b   c ${'x'.repeat(200)}` });
  const { label } = recallSession('/work');
  assert.ok(label.length <= 71);
  assert.equal(label.includes('\n'), false);
  assert.match(label, /^a b c x+…$/, "a truncated label should end in an ellipsis");
  rememberSession("/short", { sessionId: "s", label: "short enough" });
  assert.equal(recallSession("/short").label, "short enough", "a short label is left alone");
});

test('forgetting removes just that workspace', () => {
  rememberSession('/a', { sessionId: 'sa' });
  rememberSession('/b', { sessionId: 'sb' });
  assert.equal(forgetSession('/a'), true);
  assert.equal(recallSession('/a'), null);
  assert.equal(recallSession('/b').sessionId, 'sb');
  assert.equal(forgetSession('/a'), false);
});

test('a record with no session id is not stored', () => {
  assert.equal(rememberSession('/work', { sessionId: '' }), null);
  assert.equal(rememberSession('', { sessionId: 's1' }), null);
  assert.equal(recallSession('/work'), null);
});

test('listing is newest first', async () => {
  rememberSession('/old', { sessionId: 's1' });
  await new Promise((r) => setTimeout(r, 5));
  rememberSession('/new', { sessionId: 's2' });
  assert.deepEqual(listSessions().map((r) => r.root), ['/new', '/old']);
});

test('the file is kept private, since labels quote your prompts', () => {
  rememberSession('/work', { sessionId: 's1', label: 'something private' });
  assert.equal(statSync(sessionsPath).mode & 0o777, 0o600);
});

test('a corrupt pointer file is ignored rather than failing the run', () => {
  writeFileSync(sessionsPath, 'this is not json');
  assert.deepEqual(loadSessions(), {});
  assert.equal(recallSession('/work'), null);
  rememberSession('/work', { sessionId: 's1' });
  assert.equal(recallSession('/work').sessionId, 's1');
});

test('the file does not grow without bound', () => {
  for (let i = 0; i < 60; i++) rememberSession(`/root-${i}`, { sessionId: `s${i}` });
  assert.equal(listSessions().length, 50);
  assert.ok(recallSession('/root-59'), 'the newest was dropped');
});

test('no transcript is stored -- only the pointer', () => {
  rememberSession('/work', { sessionId: 's1', parentMessageId: 3, label: 'add a flag' });
  const stored = JSON.parse(readFileSync(sessionsPath, 'utf8'))['/work'];
  assert.deepEqual(Object.keys(stored).sort(), ['label', 'parentMessageId', 'sessionId', 'updated']);
});
