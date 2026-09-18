import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionHub } from '../src/hub.mjs';

const collect = (hub) => {
  const seen = [];
  hub.attach((e) => seen.push(e));
  return seen;
};

const idle = () => new Promise((r) => setImmediate(r));

test('fans every event out to all sinks', () => {
  const hub = new SessionHub({ root: '/w', run: async () => {} });
  const a = collect(hub);
  const b = collect(hub);
  hub.emit({ type: 'prose', text: 'hi' });
  assert.equal(a.length, 1);
  assert.deepEqual(a, b);
});

test('one throwing sink does not stop the others', () => {
  const hub = new SessionHub({ root: '/w', run: async () => {} });
  hub.attach(() => { throw new Error('bad sink'); });
  const good = collect(hub);
  hub.emit({ type: 'prose', text: 'hi' });
  assert.equal(good.length, 1);
});

test('detaching stops delivery', () => {
  const hub = new SessionHub({ root: '/w', run: async () => {} });
  const seen = [];
  const off = hub.attach((e) => seen.push(e));
  hub.emit({ type: 'a' });
  off();
  hub.emit({ type: 'b' });
  assert.deepEqual(seen.map((e) => e.type), ['a']);
});

test('events are indexed so a late client can replay from a point', () => {
  const hub = new SessionHub({ root: '/w', run: async () => {} });
  for (const t of ['a', 'b', 'c', 'd']) hub.emit({ type: t });
  assert.deepEqual(hub.since(0).map((e) => e.type), ['a', 'b', 'c', 'd']);
  assert.deepEqual(hub.since(2).map((e) => e.type), ['c', 'd']);
  assert.deepEqual(hub.since(4), []);
});

test('runs queued tasks one at a time, in order', async () => {
  const order = [];
  let running = 0;
  const hub = new SessionHub({
    root: '/w',
    run: async (task) => {
      running++;
      assert.equal(running, 1, 'two tasks ran at once');
      order.push(task);
      await idle();
      running--;
    },
  });

  hub.submit('one', 'terminal');
  hub.submit('two', 'web');
  hub.submit('three', 'web');
  await hub.settled();

  assert.deepEqual(order, ['one', 'two', 'three']);
  assert.equal(hub.busy, false);
});

test('an empty task is not accepted', () => {
  const hub = new SessionHub({ root: '/w', run: async () => {} });
  assert.equal(hub.submit('   '), false);
  assert.equal(hub.submit(null), false);
});

test('a task that throws is reported, and the queue keeps going', async () => {
  const done = [];
  const hub = new SessionHub({
    root: '/w',
    run: async (task) => { if (task === 'boom') throw new Error('it broke'); done.push(task); },
  });
  const seen = collect(hub);
  hub.submit('boom');
  hub.submit('after');
  await hub.settled();

  assert.deepEqual(done, ['after']);
  const err = seen.find((e) => e.type === 'error');
  assert.match(err.message, /it broke/);
});

test('an approval resolves on the first answer, whoever gives it', async () => {
  const hub = new SessionHub({ root: '/w', run: async () => {} });
  const seen = collect(hub);

  const pending = hub.askApproval('write a.txt');
  const ask = seen.find((e) => e.type === 'ask');
  assert.ok(ask.id);

  assert.equal(hub.answer(ask.id, true, 'web'), true);
  assert.equal(await pending, true);

  const answer = seen.find((e) => e.type === 'answer');
  assert.deepEqual([answer.ok, answer.by], [true, 'web']);
});

test('the terminal can win the race just as well', async () => {
  const hub = new SessionHub({ root: '/w', run: async () => {} });
  const seen = collect(hub);
  const pending = hub.askApproval('write a.txt');
  const { id } = seen.find((e) => e.type === 'ask');

  hub.answer(id, false, 'terminal');
  assert.equal(await pending, false);
  assert.equal(seen.find((e) => e.type === 'answer').by, 'terminal');
});

test('a second answer for a settled approval is ignored', async () => {
  const hub = new SessionHub({ root: '/w', run: async () => {} });
  const seen = collect(hub);
  const pending = hub.askApproval('write a.txt');
  const { id } = seen.find((e) => e.type === 'ask');

  assert.equal(hub.answer(id, true, 'web'), true);
  assert.equal(hub.answer(id, false, 'terminal'), false, 'the late answer was accepted');
  assert.equal(await pending, true);
  assert.equal(seen.filter((e) => e.type === 'answer').length, 1);
});

test('an answer for an unknown id is refused', () => {
  const hub = new SessionHub({ root: '/w', run: async () => {} });
  assert.equal(hub.answer('nope', true), false);
});

test('an approval left hanging when the task ends is declined, not leaked', async () => {
  // Otherwise the promise never settles and the loop waits for a click that
  // can no longer arrive.
  let captured;
  const hub = new SessionHub({
    root: '/w',
    run: async (task, { approve }) => { captured = approve('write a.txt'); },
  });
  hub.submit('go');
  await hub.settled();
  assert.equal(await captured, false);
});

test('status reports the root, busy flag and any outstanding ask', async () => {
  const hub = new SessionHub({ root: '/work', run: async () => {} });
  assert.deepEqual(hub.status().root, '/work');
  assert.equal(hub.status().busy, false);
  assert.equal(hub.status().ask, null);

  hub.askApproval('write a.txt');
  assert.equal(hub.status().ask.label, 'write a.txt');
});

test('the ui adapter turns runAgent callbacks into events', () => {
  const hub = new SessionHub({ root: '/w', run: async () => {} });
  const seen = collect(hub);
  const ui = hub.ui();

  ui.step(1, 24);
  ui.prose('hello');
  ui.toolOk('write a.txt', 'created a.txt');
  ui.toolError('write ../x', 'escapes the root');
  ui.skipped('write b.txt');
  ui.done(3, true);

  assert.deepEqual(seen.map((e) => e.type),
    ['step', 'prose', 'tool', 'tool', 'tool', 'done']);
  assert.deepEqual(seen.filter((e) => e.type === 'tool').map((e) => e.status),
    ['ok', 'error', 'skipped']);
});
