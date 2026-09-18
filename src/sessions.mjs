// Remembers which chat.deepseek.com conversation belongs to which workspace.
//
// The conversation itself lives on DeepSeek's servers, keyed by chat_session_id
// and parent_message_id -- that is the whole reason the agent loop can send just
// a task and have the model remember the files it read. But those two ids only
// ever existed in memory, so quitting threw away a conversation the server was
// still perfectly happy to continue.
//
// This file is that pointer, and nothing more. No transcript is stored: on
// resume the model has the history, the terminal does not, which is why
// `--resume` prints what the session was about rather than replaying it.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './config.mjs';

const FILE = join(configDir, 'sessions.json');
const MAX_ROOTS = 50;          // one record per workspace; forget the stalest
const LABEL = 70;              // characters of the opening task kept as a label

export const sessionsPath = FILE;

// One line, and cut at a word so a listing does not end mid-syllable.
function trim(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= LABEL) return flat;
  const cut = flat.slice(0, LABEL);
  const space = cut.lastIndexOf(' ');
  return `${(space > LABEL * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function loadSessions() {
  if (!existsSync(FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};   // a corrupt pointer file is not worth failing a run over
  }
}

function save(all) {
  // Keep the file bounded; the oldest workspaces are the least likely resumed.
  const entries = Object.entries(all)
    .sort((a, b) => String(b[1]?.updated ?? '').localeCompare(String(a[1]?.updated ?? '')))
    .slice(0, MAX_ROOTS);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, { mode: 0o600 });
  chmodSync(FILE, 0o600);      // the labels quote your prompts; keep it private
}

export function rememberSession(root, { sessionId, parentMessageId, label } = {}) {
  if (!root || !sessionId) return null;
  const all = loadSessions();
  const previous = all[root];
  const record = {
    sessionId,
    parentMessageId: parentMessageId ?? null,
    // The label is set by the first task and then left alone, so a session
    // keeps the name of what it set out to do.
    label: previous?.sessionId === sessionId ? previous.label : trim(label),
    updated: new Date().toISOString(),
  };
  all[root] = record;
  save(all);
  return record;
}

export function recallSession(root) {
  const record = loadSessions()[root];
  return record?.sessionId ? record : null;
}

export function forgetSession(root) {
  const all = loadSessions();
  if (!(root in all)) return false;
  delete all[root];
  save(all);
  return true;
}

// Newest first, for `clichat code --sessions`.
export function listSessions() {
  return Object.entries(loadSessions())
    .map(([root, r]) => ({ root, ...r }))
    .sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')));
}
