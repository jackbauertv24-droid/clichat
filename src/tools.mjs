// Tool-call emulation for a backend with no native function calling.
//
// The DeepSeek web API has no tools concept, so we render the caller's tool
// schemas into the prompt, ask for a sentinel-prefixed JSON reply, and convert
// that reply back into OpenAI `tool_calls`. Enabled with --emulate-tools.
//
// The sentinel exists so streaming can stay streaming: we only have to withhold
// output while the reply still *might* be a tool call. Prose is recognised on
// the first non-whitespace character and streams through untouched.

import { randomUUID } from 'node:crypto';

export const SENTINEL = '<<<TOOL_CALL>>>';

const callId = () => `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

export function toolsSignature(tools) {
  return JSON.stringify((tools || []).map((t) => t.function?.name ?? t.name)); 
}

// The instruction block prepended to a prompt when tools are in play.
export function renderToolPrompt(tools, toolChoice) {
  const lines = ['You have access to the following tools:', ''];
  for (const t of tools) {
    const f = t.function ?? t;
    lines.push(`- ${f.name}: ${f.description || '(no description)'}`);
    if (f.parameters) lines.push(`  arguments JSON Schema: ${JSON.stringify(f.parameters)}`);
  }
  lines.push(
    '',
    'To call a tool, reply with EXACTLY the following and nothing else:',
    SENTINEL,
    '{"name": "<tool name>", "arguments": {<arguments matching the schema>}}',
    '',
    'To call several tools at once, put an array after the marker instead:',
    SENTINEL,
    '[{"name": "...", "arguments": {}}, {"name": "...", "arguments": {}}]',
    '',
    'Rules:',
    '- Emit raw JSON. Do not wrap it in markdown fences or add commentary.',
    '- Never mix prose and a tool call in one reply.',
    '- "arguments" must be a JSON object, even when empty.',
  );

  const forced = typeof toolChoice === 'object' && toolChoice?.function?.name;
  if (forced) lines.push(`- You must call the tool "${forced}" now.`);
  else if (toolChoice === 'required' || toolChoice === 'any') {
    lines.push('- You must call one of the tools now; do not reply with prose.');
  } else {
    lines.push('- If no tool is needed, just answer normally.');
  }
  return lines.join('\n');
}

// A short nudge for turns that resume a session which already saw the schemas.
export const toolReminder = () =>
  `(Tools remain available. To call one, reply with ${SENTINEL} followed by JSON.)`;

// Finds the first balanced JSON object/array in a string, tolerating prose or
// markdown fences around it.
export function extractJson(text) {
  const cleaned = String(text)
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '');
  const start = cleaned.search(/[{[]/);
  if (start < 0) return null;

  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

function loose(json) {
  try { return JSON.parse(json); } catch { /* try a repair */ }
  // Most common model slip: a trailing comma before a closing brace/bracket.
  try { return JSON.parse(json.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

// Returns [{id, name, arguments}] or null if `text` is not a usable tool call.
export function parseToolCalls(text) {
  let body = String(text);
  const at = body.indexOf(SENTINEL);
  if (at >= 0) body = body.slice(at + SENTINEL.length);

  const raw = extractJson(body);
  if (!raw) return null;
  const parsed = loose(raw);
  if (!parsed) return null;

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [parsed];

  const calls = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const fn = item.function ?? item;
    const name = fn.name ?? item.name;
    if (typeof name !== 'string' || !name) continue;
    let args = fn.arguments ?? fn.parameters ?? item.arguments ?? {};
    if (typeof args === 'string') args = loose(args) ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) args = {};
    calls.push({ id: item.id || callId(), name, arguments: args });
  }
  return calls.length ? calls : null;
}

export const toOpenAIToolCalls = (calls) => calls.map((c, index) => ({
  index,
  id: c.id,
  type: 'function',
  function: { name: c.name, arguments: JSON.stringify(c.arguments) },
}));

// Decides, as tokens arrive, whether a reply is prose (stream it immediately)
// or a possible tool call (withhold until the end, then convert or flush).
export class ToolOutputFilter {
  constructor(active) {
    this.active = active;
    this.state = active ? 'undecided' : 'prose';
    this.buffer = '';
    this.emitted = false;
  }

  // A reply is still "possibly a tool call" while it could grow into one.
  static mightBeCall(trimmed) {
    if (!trimmed) return true;
    if (trimmed.startsWith(SENTINEL)) return true;
    if (SENTINEL.startsWith(trimmed)) return true;   // sentinel still arriving
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return true;
    if (trimmed.startsWith('```')) return true;
    return '```'.startsWith(trimmed);
  }

  // Returns the text that may be forwarded to the client right now.
  push(text) {
    if (this.state === 'prose') { this.emitted = true; return text; }
    this.buffer += text;
    const trimmed = this.buffer.trimStart();
    if (ToolOutputFilter.mightBeCall(trimmed)) { this.state = 'buffering'; return ''; }
    this.state = 'prose';
    const out = this.buffer;
    this.buffer = '';
    this.emitted = true;
    return out;
  }

  // Returns {toolCalls} or {text} with whatever was withheld.
  finish() {
    if (this.state === 'prose') return { text: '' };
    const calls = parseToolCalls(this.buffer);
    if (calls) return { toolCalls: calls };
    const text = this.buffer;
    this.buffer = '';
    return { text };
  }
}
