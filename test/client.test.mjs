import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../src/client.mjs';

// Feeds events through the parser as SSE lines, optionally split mid-line.
async function collect(events, chunkSize = Infinity) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  async function* body() {
    for (let i = 0; i < text.length; i += Math.min(chunkSize, text.length)) {
      yield Buffer.from(text.slice(i, i + chunkSize));
    }
  }
  const out = { content: '', thinking: '', ids: [] };
  for await (const ev of parseSSE(body())) {
    if (ev.type === 'message_id') out.ids.push(ev.id);
    else out[ev.type] += ev.text;
  }
  return out;
}

// Captured verbatim (fields trimmed) from chat.deepseek.com. The first token
// rides inside the fragment that the opening event creates.
const captured = [
  { request_message_id: 1, response_message_id: 2, model_type: 'default' },
  { v: { response: {
    message_id: 2, parent_id: 1, role: 'ASSISTANT', status: 'WIP',
    fragments: [{ id: 2, type: 'RESPONSE', content: 'You', references: [], stage_id: 1 }],
  } } },
  { p: 'response/fragments/-1/content', o: 'APPEND', v: "'re" },
  { v: ' right' }, { v: ',' }, { v: ' it' }, { v: "'s" }, { v: ' done' }, { v: '.' },
  { p: 'response', o: 'BATCH', v: [
    { p: 'accumulated_token_usage', v: 58 }, { p: 'quasi_status', v: 'FINISHED' },
  ] },
  { p: 'response/status', o: 'SET', v: 'FINISHED' },
  { content: 'Done' },
];

test('keeps the first token that arrives inside a new fragment', async () => {
  const out = await collect(captured);
  assert.equal(out.content, "You're right, it's done.");
  assert.equal(out.thinking, '');
  assert.deepEqual(out.ids, [2]);
});

test('survives events split across network chunks', async () => {
  const out = await collect(captured, 7);
  assert.equal(out.content, "You're right, it's done.");
});

test('routes a THINK fragment to thinking and an appended RESPONSE fragment to content',
  async () => {
    const out = await collect([
      { v: { response: { message_id: 4, fragments: [{ type: 'THINK', content: 'Hmm' }] } } },
      { p: 'response/fragments/-1/content', o: 'APPEND', v: ', easy' },
      { v: '.' },
      { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'Yes' }] },
      { p: 'response/fragments/-1/content', o: 'APPEND', v: ', it' },
      { v: ' is.' },
    ]);
    assert.equal(out.thinking, 'Hmm, easy.');
    assert.equal(out.content, 'Yes, it is.');
  });

test('still reads the older content / thinking_content paths', async () => {
  const out = await collect([
    { v: { response: { message_id: 3, thinking_content: 'a', content: '' } } },
    { p: 'response/thinking_content', v: 'b' },
    { p: 'response/content', v: 'X' },
    { v: 'Y' },
  ]);
  assert.equal(out.thinking, 'ab');
  assert.equal(out.content, 'XY');
});
