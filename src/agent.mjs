// A native agent loop over the DeepSeek web backend.
//
// `clichat serve --emulate-tools` exists to satisfy someone else's contract: it
// takes OpenAI tool schemas, renders them into a prompt, and converts the reply
// back. That round trip costs twice. The schemas arrive as JSON Schema, which is
// verbose to state in a prompt, and the reply has to come back as JSON, which is
// the worst available format for the thing an agent mostly does -- emit the
// contents of a source file. Every newline and quote has to survive escaping,
// and a model that was never trained to call tools is exactly the model that
// gets that wrong.
//
// Owning both ends removes the round trip. The grammar here is an XML-ish tag
// with a raw body, so file contents need no escaping at all, and the toolset is
// three verbs described in a sentence each rather than a schema dump.
//
// It also drops the statefulness problem. The OpenAI API is stateless, so
// server.mjs keeps an LRU of conversation prefixes to avoid resending the whole
// history every turn. chat.deepseek.com is stateful natively: the session holds
// the conversation, so each turn of this loop sends only the new tool results.

import { tools, ToolError } from './fstools.mjs';

const NS = 'clichat';
const OPEN = new RegExp(`<${NS}:([a-z]+)((?:\\s+[a-z_]+\\s*=\\s*(?:"[^"]*"|'[^']*'))*)\\s*(/?)>`, 'g');

// ---------------------------------------------------------------- protocol

export function renderSystemPrompt(root) {
  const lines = [
    'You are a coding agent working in a checkout. You act by emitting tool tags.',
    '',
    'TOOLS',
  ];
  // Usage is rendered flush left. Indenting it would invite the model to indent
  // a tag body too, and a body is literal -- the indentation would land in the
  // file, or shift a SEARCH block away from what it is meant to match.
  for (const t of Object.values(tools)) {
    lines.push(`# ${t.summary}`, t.usage, '');
  }
  lines.push(
    'RULES',
    '- A tool tag must start at the beginning of a line.',
    '- Do NOT wrap tool tags in markdown fences. Emit them raw.',
    '- Paths are relative to the workspace root. Never use absolute paths or "..".',
    '- Use edit to change a file that already exists, and write only to create a',
    '  new one or to replace a file wholesale.',
    '- Read a file before you edit it, and quote the SEARCH lines exactly as they',
    '  appear, including indentation. SEARCH must match one place in the file; if',
    '  it could match more, include more surrounding lines.',
    '- write replaces the whole file. Emit the complete new contents, never a diff',
    '  and never a fragment with "... rest unchanged".',
    '- The body of a write tag is literal file content. Do not escape it.',
    '- You may emit several tags in one reply; they run in order.',
    '- After each reply that contains tags, you will be shown the results and can',
    '  continue. When the task is done, reply with prose and no tags at all.',
    '- Keep prose short. Say what you are about to do, not what you might do.',
    '',
    `The workspace root is ${root}`,
  );
  return lines.join('\n');
}

function parseAttrs(s) {
  const out = {};
  for (const m of String(s || '').matchAll(/([a-z_]+)\s*=\s*"([^"]*)"|([a-z_]+)\s*=\s*'([^']*)'/g)) {
    if (m[1] !== undefined) out[m[1]] = m[2];
    else out[m[3]] = m[4];
  }
  return out;
}

// Pulls every tool tag out of a finished reply, in order.
//
// A raw body means the body could itself contain the closing tag -- a file that
// quotes this protocol, most obviously this very file. We take the FIRST close,
// which is what the model is told to produce; the alternative (last close)
// breaks two legitimate writes in one reply, which is far more common.
export function parseToolTags(text) {
  const src = String(text);
  const calls = [];
  OPEN.lastIndex = 0;
  let m;
  while ((m = OPEN.exec(src))) {
    const [full, name, attrs, selfClose] = m;
    const tool = tools[name];
    if (!tool) continue;

    if (selfClose || !tool.body) {
      calls.push({ name, args: parseAttrs(attrs), body: '' });
      continue;
    }
    const closeTag = `</${NS}:${name}>`;
    const bodyStart = m.index + full.length;
    const end = src.indexOf(closeTag, bodyStart);
    if (end < 0) {
      calls.push({ name, args: parseAttrs(attrs), body: '', unterminated: true });
      break;
    }
    // A body is a block: drop one leading newline after the tag and one
    // trailing newline before the close, so the file does not gain blank lines.
    let body = src.slice(bodyStart, end);
    body = body.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    calls.push({ name, args: parseAttrs(attrs), body });
    OPEN.lastIndex = end + closeTag.length;
  }
  return calls;
}

// Feeds results back as the next turn's prompt. Same tag shape as the calls, so
// the model sees one consistent syntax rather than two.
export function renderResults(results) {
  const parts = results.map((r) => [
    `<${NS}:result tool="${r.name}" status="${r.ok ? 'ok' : 'error'}">`,
    r.output,
    `</${NS}:result>`,
  ].join('\n'));
  parts.push('', 'Continue, or reply with prose and no tags if the task is done.');
  return parts.join('\n');
}

// Hides tag syntax from the terminal while prose streams through.
//
// Everything from the first tag onward is suppressed: the loop prints a one-line
// summary per call afterwards, which is far more readable than watching a file
// scroll past twice.
export class TagSuppressor {
  constructor() { this.done = false; this.tail = ''; }

  push(text) {
    if (this.done) return '';
    this.tail += text;
    const at = this.tail.indexOf(`<${NS}:`);
    if (at >= 0) {
      const out = this.tail.slice(0, at);
      this.done = true;
      this.tail = '';
      return out;
    }
    // Hold back a partial tag that may still be arriving.
    const keep = Math.max(0, this.tail.length - NS.length - 2);
    const out = this.tail.slice(0, keep);
    this.tail = this.tail.slice(keep);
    return out;
  }

  finish() { const out = this.done ? '' : this.tail; this.tail = ''; return out; }
}

// ---------------------------------------------------------------- the loop

// One conversation. Held across tasks so a follow-up ("now do the same for the
// other handler") lands in a model that still remembers the files it just read.
export function createAgentSession(root) {
  return { root, sessionId: null, parentMessageId: null, primed: false };
}

export async function runAgent({
  client, task, session, maxSteps = 24,
  thinking = false, approve = async () => true, ui,
}) {
  const ctx = { root: session.root };
  if (!session.sessionId) session.sessionId = await client.createSession();

  // The tool instructions are sent once. The backend is stateful, so repeating
  // them every task would pay for context the session already has.
  const prompt0 = session.primed
    ? task
    : `${renderSystemPrompt(session.root)}\n\nTASK: ${task}`;
  session.primed = true;
  let prompt = prompt0;

  for (let step = 1; step <= maxSteps; step++) {
    ui.step(step, maxSteps);

    const suppress = new TagSuppressor();
    let reply = '';
    let thinkingSeen = false;

    for await (const ev of client.stream({
      sessionId: session.sessionId,
      parentMessageId: session.parentMessageId,
      prompt,
      thinking,
    })) {
      if (ev.type === 'message_id') { session.parentMessageId = ev.id; continue; }
      if (ev.type === 'thinking') {
        if (!thinkingSeen) { ui.thinkingStart(); thinkingSeen = true; }
        ui.thinking(ev.text);
        continue;
      }
      if (ev.type !== 'content') continue;
      reply += ev.text;
      const visible = suppress.push(ev.text);
      if (visible) ui.prose(visible);
    }
    const tailProse = suppress.finish();
    if (tailProse) ui.prose(tailProse);
    ui.endTurn();

    const calls = parseToolTags(reply);
    if (!calls.length) return { done: true, steps: step };

    const results = [];
    for (const call of calls) {
      const tool = tools[call.name];
      if (call.unterminated) {
        ui.toolError(call.name, 'reply ended mid-tag');
        results.push({
          name: call.name, ok: false,
          output: `the <${NS}:${call.name}> tag was never closed; re-send it complete`,
        });
        continue;
      }

      const label = tool.describe(call.args, call.body);
      if (tool.mutates && !(await approve(label, call))) {
        ui.skipped(label);
        results.push({ name: call.name, ok: false, output: 'the user declined this action' });
        continue;
      }

      try {
        const output = tool.run(ctx, call.args, call.body);
        ui.toolOk(label, output);
        results.push({ name: call.name, ok: true, output });
      } catch (err) {
        const msg = err instanceof ToolError ? err.message : `${err.code || ''} ${err.message}`.trim();
        ui.toolError(label, msg);
        results.push({ name: call.name, ok: false, output: msg });
      }
    }
    prompt = renderResults(results);
  }
  return { done: false, steps: maxSteps };
}
