import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, existsSync, linkSync,
  realpathSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseToolTags, renderResults, TagSuppressor, renderSystemPrompt } from '../src/agent.mjs';
import { tools, safePath, resolveRoot, ToolError } from '../src/fstools.mjs';

const sandbox = () => mkdtempSync(join(tmpdir(), 'clichat-test-'));

// ------------------------------------------------------------- tag parsing

test('parses a self-closing tag', () => {
  assert.deepEqual(parseToolTags('<clichat:read path="src/a.js"/>'),
    [{ name: 'read', args: { path: 'src/a.js' }, body: '' }]);
});

test('parses a body tag and strips the framing newlines', () => {
  const [call] = parseToolTags('<clichat:write path="a.txt">\nline1\nline2\n</clichat:write>');
  assert.equal(call.body, 'line1\nline2');
});

test('keeps blank lines inside a body', () => {
  const [call] = parseToolTags('<clichat:write path="a.txt">\na\n\nb\n</clichat:write>');
  assert.equal(call.body, 'a\n\nb');
});

test('body content needs no escaping -- quotes, braces, backslashes survive', () => {
  const src = 'const re = /"\\\\{}/;\nconst s = "a\\"b";\n{"json": [1,2]}';
  const [call] = parseToolTags(`<clichat:write path="a.js">\n${src}\n</clichat:write>`);
  assert.equal(call.body, src);
});

test('reads several tags in one reply, in order', () => {
  const calls = parseToolTags([
    'I will look first.',
    '<clichat:read path="a.js"/>',
    '<clichat:write path="b.js">\nhi\n</clichat:write>',
    '<clichat:list path="src"/>',
  ].join('\n'));
  assert.deepEqual(calls.map((c) => c.name), ['read', 'write', 'list']);
  assert.equal(calls[1].body, 'hi');
});

test('prose around tags is ignored', () => {
  const calls = parseToolTags('Sure! Let me do that.\n<clichat:list path="."/>\nDone.');
  assert.equal(calls.length, 1);
});

test('no tags means no calls -- that is how a task terminates', () => {
  assert.deepEqual(parseToolTags('All done. The bug was a missing await.'), []);
});

test('unknown tool names are skipped, not guessed at', () => {
  assert.deepEqual(parseToolTags('<clichat:rm path="/"/>'), []);
});

test('single quotes are tolerated', () => {
  const [call] = parseToolTags("<clichat:read path='a.js'/>");
  assert.equal(call.args.path, 'a.js');
});

test('an unterminated write is flagged rather than silently truncated', () => {
  const [call] = parseToolTags('<clichat:write path="a.js">\nhalf a fi');
  assert.equal(call.unterminated, true);
});

test('two writes in one reply both survive (first-close wins)', () => {
  const calls = parseToolTags(
    '<clichat:write path="a">\nA\n</clichat:write>\n<clichat:write path="b">\nB\n</clichat:write>',
  );
  assert.deepEqual(calls.map((c) => [c.args.path, c.body]), [['a', 'A'], ['b', 'B']]);
});

test('the system prompt names every tool', () => {
  const p = renderSystemPrompt('/work');
  for (const name of Object.keys(tools)) assert.match(p, new RegExp(`clichat:${name}`));
  assert.match(p, /\/work/);
});

test('results render as tags the model already understands', () => {
  const out = renderResults([{ name: 'read', ok: true, output: 'hi' }]);
  assert.match(out, /<clichat:result tool="read" status="ok">/);
  assert.match(out, /hi/);
});

// ------------------------------------------------------- stream suppression

const drive = (chunks) => {
  const s = new TagSuppressor();
  return chunks.map((c) => s.push(c)).join('') + s.finish();
};

test('prose with no tags streams through untouched', () => {
  assert.equal(drive(['Hello ', 'there, ', 'world.']), 'Hello there, world.');
});

test('everything from the first tag onward is hidden', () => {
  assert.equal(drive(['Writing it.\n', '<clichat:write path="a">\nbody\n</clichat:write>']),
    'Writing it.\n');
});

test('a tag split across chunk boundaries is still caught', () => {
  assert.equal(drive(['ok\n', '<cli', 'chat:', 'read path="a"/>']), 'ok\n');
});

test('a lone angle bracket is not mistaken for a tag', () => {
  assert.equal(drive(['use a < b and ', 'then c > d']), 'use a < b and then c > d');
});

// -------------------------------------------------------------------- tools

test('write creates parent directories and reports what it did', () => {
  const root = sandbox();
  const out = tools.write.run({ root }, { path: 'deep/nested/a.txt' }, 'hello\nthere');
  assert.match(out, /^created deep\/nested\/a\.txt/);
  assert.equal(readFileSync(join(root, 'deep/nested/a.txt'), 'utf8'), 'hello\nthere');
});

test('write says "overwrote" the second time', () => {
  const root = sandbox();
  tools.write.run({ root }, { path: 'a.txt' }, 'one');
  assert.match(tools.write.run({ root }, { path: 'a.txt' }, 'two'), /^overwrote/);
});

test('read round-trips what write wrote', () => {
  const root = sandbox();
  const body = 'const x = "quoted";\n\ttabbed\n';
  tools.write.run({ root }, { path: 'a.js' }, body);
  assert.equal(tools.read.run({ root }, { path: 'a.js' }), body);
});

test('read of a missing file is a ToolError, not a crash', () => {
  const root = sandbox();
  assert.throws(() => tools.read.run({ root }, { path: 'nope.js' }), ToolError);
});

test('list marks directories and skips noise', () => {
  const root = sandbox();
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'a.txt'), 'x');
  const out = tools.list.run({ root }, { path: '.' });
  assert.match(out, /^src\/$/m);
  assert.match(out, /^a\.txt\s+1b$/m);
  assert.doesNotMatch(out, /node_modules/);
});

test('list of a file points you at read instead', () => {
  const root = sandbox();
  writeFileSync(join(root, 'a.txt'), 'x');
  assert.throws(() => tools.list.run({ root }, { path: 'a.txt' }), /use read/);
});

// ------------------------------------------------------- escaping the root
//
// These are the cases that decide whether a wrong path in a model reply is a
// harmless error or a problem on the user's machine, so each one is pinned.

test('a path inside the root is allowed', () => {
  const root = sandbox();
  assert.equal(safePath(root, 'a/b.txt'), join(root, 'a/b.txt'));
});

for (const p of [
  '../escape.txt', '../../etc/passwd', '/etc/passwd',
  'a/../../../etc/passwd', './././../x', 'sub/../../out.txt',
]) {
  test(`traversal is refused: ${p}`, () => {
    const root = sandbox();
    assert.throws(() => safePath(root, p), ToolError);
  });
}

test('a null byte in the path is refused', () => {
  assert.throws(() => safePath(sandbox(), 'a\0b'), ToolError);
});

test('an empty path is refused', () => {
  assert.throws(() => safePath(sandbox(), '   '), ToolError);
});

test('a symlinked directory in the middle is refused', () => {
  const root = sandbox();
  const outside = sandbox();
  writeFileSync(join(outside, 'secret.txt'), 'shh');
  symlinkSync(outside, join(root, 'link'));
  assert.throws(() => safePath(root, 'link/secret.txt'), ToolError);
  assert.throws(() => tools.write.run({ root }, { path: 'link/new.txt' }, 'x'), ToolError);
});

test('a live symlink at the leaf is not followed', () => {
  const root = sandbox();
  const outside = sandbox();
  const victim = join(outside, 'real.txt');
  writeFileSync(victim, 'secret');
  symlinkSync(victim, join(root, 'live'));

  assert.throws(() => tools.write.run({ root }, { path: 'live' }, 'OWNED'), ToolError);
  assert.throws(() => tools.read.run({ root }, { path: 'live' }), ToolError);
  assert.equal(readFileSync(victim, 'utf8'), 'secret');
});

test('a DANGLING symlink at the leaf is not followed', () => {
  // The subtle one: existsSync follows links, so a dangling link reads as
  // "this leaf does not exist yet" and resolves innocently against the root.
  // The write would then create the file outside the workspace.
  const root = sandbox();
  const outside = sandbox();
  const victim = join(outside, 'pwned.txt');
  symlinkSync(victim, join(root, 'innocent.txt'));

  assert.throws(() => tools.write.run({ root }, { path: 'innocent.txt' }, 'OWNED'), ToolError);
  assert.equal(existsSync(victim), false, 'a file was created outside the root');
});

test('a hard link sharing an inode with a file outside is not written', () => {
  const root = sandbox();
  const outside = sandbox();
  const victim = join(outside, 'important.txt');
  writeFileSync(victim, 'important');
  try {
    linkSync(victim, join(root, 'hardlink.txt'));
  } catch {
    return; // separate filesystems; nothing to test here
  }
  assert.throws(() => tools.write.run({ root }, { path: 'hardlink.txt' }, 'OWNED'), ToolError);
  assert.equal(readFileSync(victim, 'utf8'), 'important');
});

test('a fifo is refused rather than blocking the read forever', () => {
  const root = sandbox();
  try {
    execFileSync('mkfifo', [join(root, 'pipe')]);
  } catch {
    return; // no mkfifo here
  }
  assert.throws(() => tools.read.run({ root }, { path: 'pipe' }), /not an ordinary file/);
  assert.throws(() => tools.write.run({ root }, { path: 'pipe' }, 'x'), /not an ordinary file/);
});

test('list marks symlinks instead of following them', () => {
  const root = sandbox();
  const outside = sandbox();
  symlinkSync(outside, join(root, 'link'));
  assert.match(tools.list.run({ root }, { path: '.' }), /link {2}\(symlink, not followed\)/);
});

// ------------------------------------------------------------ the root itself

test('a normal directory is accepted, and comes back fully resolved', () => {
  const root = sandbox();
  mkdirSync(join(root, 'project'));
  assert.equal(resolveRoot(join(root, 'project/.')), join(realpathSync(root), 'project'));
});

for (const dir of ['/', '/etc', '/usr', '/var', '/dev', '/proc']) {
  test(`a root of ${dir} is refused`, () => {
    assert.throws(() => resolveRoot(dir), ToolError);
  });
}

test('the home directory is refused as a root', () => {
  assert.throws(() => resolveRoot(homedir()), /home directory/);
});

test('a missing root is refused', () => {
  assert.throws(() => resolveRoot('/nonexistent-clichat-root'), /no such directory/);
});

test('a file is refused as a root', () => {
  const root = sandbox();
  writeFileSync(join(root, 'f.txt'), 'x');
  assert.throws(() => resolveRoot(join(root, 'f.txt')), ToolError);
});

// ------------------------------------------------------------------- editing

import { parseEditBlocks, applyEdits } from '../src/fstools.mjs';

const block = (search, replace) =>
  `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

test('parses one SEARCH/REPLACE block', () => {
  assert.deepEqual(parseEditBlocks(block('old', 'new')), [{ search: 'old', replace: 'new' }]);
});

test('parses several blocks from one body', () => {
  const blocks = parseEditBlocks(`${block('a', 'A')}\n${block('b', 'B')}`);
  assert.deepEqual(blocks.map((b) => b.search), ['a', 'b']);
});

test('markers are tolerated when the model indents them', () => {
  const body = block('old', 'new').split('\n').map((l) => `    ${l}`).join('\n');
  assert.equal(parseEditBlocks(body)[0].search, '    old');
});

test('a body with no block at all is an error', () => {
  assert.throws(() => parseEditBlocks('please change foo to bar'), /SEARCH/);
});

test('a block missing its divider is an error, not a silent half-edit', () => {
  assert.throws(() => parseEditBlocks('<<<<<<< SEARCH\nold\n>>>>>>> REPLACE'), /divider/);
});

test('an empty SEARCH is refused -- that is what write is for', () => {
  assert.throws(() => parseEditBlocks('<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE'),
    /empty SEARCH/);
});

test('applies an exact match', () => {
  const { text, changed } = applyEdits('a\nb\nc\n', parseEditBlocks(block('b', 'B')));
  assert.equal(text, 'a\nB\nc\n');
  assert.equal(changed, 1);
});

test('applies several blocks in order', () => {
  const { text } = applyEdits('a\nb\nc\n', parseEditBlocks(`${block('a', 'A')}\n${block('c', 'C')}`));
  assert.equal(text, 'A\nb\nC\n');
});

test('a multi-line replacement can grow the file', () => {
  const { text } = applyEdits('x\nb\ny\n', parseEditBlocks(block('b', 'b1\nb2\nb3')));
  assert.equal(text, 'x\nb1\nb2\nb3\ny\n');
});

test('an empty REPLACE deletes the lines', () => {
  const { text } = applyEdits('a\nb\nc\n', parseEditBlocks('<<<<<<< SEARCH\nb\n=======\n>>>>>>> REPLACE'));
  assert.equal(text, 'a\nc\n');
});

test('AMBIGUITY IS AN ERROR -- editing the wrong one of two matches is the risk', () => {
  assert.throws(
    () => applyEdits('x\nfoo\ny\nfoo\nz\n', parseEditBlocks(block('foo', 'bar'))),
    /matches 2 places/,
  );
});

test('more context resolves the ambiguity', () => {
  const { text } = applyEdits('x\nfoo\ny\nfoo\nz\n', parseEditBlocks(block('y\nfoo', 'y\nbar')));
  assert.equal(text, 'x\nfoo\ny\nbar\nz\n');
});

test('text that is simply not there is an error naming the block', () => {
  assert.throws(() => applyEdits('a\n', parseEditBlocks(block('nope', 'x'))), /block 1 is not in the file/);
});

test('trailing whitespace in the quoted lines is tolerated', () => {
  const { text } = applyEdits('a\n  b\nc\n', parseEditBlocks(block('  b   ', '  B')));
  assert.equal(text, 'a\n  B\nc\n');
});

test('a uniformly re-indented SEARCH still matches, and the fix keeps the file indent', () => {
  // The model quotes the body of a function without its surrounding indentation.
  const file = 'function f() {\n    const a = 1;\n    return a;\n}\n';
  const { text } = applyEdits(file, parseEditBlocks(block('const a = 1;\nreturn a;', 'const a = 2;\nreturn a * 2;')));
  assert.equal(text, 'function f() {\n    const a = 2;\n    return a * 2;\n}\n');
});

test('a NON-uniform indent shift does not match -- that would be a guess', () => {
  const file = 'if (x) {\n    a();\n        b();\n}\n';
  assert.throws(() => applyEdits(file, parseEditBlocks(block('a();\nb();', 'c();'))), /not in the file/);
});

test('CRLF files keep their line endings', () => {
  const { text } = applyEdits('a\r\nb\r\nc\r\n', parseEditBlocks(block('b', 'B')));
  assert.equal(text, 'a\r\nB\r\nc\r\n');
});

test('edit writes the file and reports what changed', () => {
  const root = sandbox();
  writeFileSync(join(root, 'a.js'), 'const x = 1;\nexport default x;\n');
  const out = tools.edit.run({ root }, { path: 'a.js' }, block('const x = 1;', 'const x = 42;'));
  assert.match(out, /^edited a\.js \(1 block/);
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), 'const x = 42;\nexport default x;\n');
});

test('edit on a missing file points at write', () => {
  assert.throws(() => tools.edit.run({ root: sandbox() }, { path: 'nope.js' }, block('a', 'b')),
    /use write to create it/);
});

test('edit obeys the same confinement as write', () => {
  const root = sandbox();
  const outside = sandbox();
  const victim = join(outside, 'real.txt');
  writeFileSync(victim, 'secret');
  symlinkSync(victim, join(root, 'live'));
  assert.throws(() => tools.edit.run({ root }, { path: 'live' }, block('secret', 'OWNED')), ToolError);
  assert.throws(() => tools.edit.run({ root }, { path: '../x' }, block('a', 'b')), ToolError);
  assert.equal(readFileSync(victim, 'utf8'), 'secret');
});

test('a no-op edit says so instead of claiming a change', () => {
  const root = sandbox();
  writeFileSync(join(root, 'a.js'), 'same\n');
  assert.match(tools.edit.run({ root }, { path: 'a.js' }, block('same', 'same')), /nothing changed/);
});

// -------------------------------------------------------------- the loop
//
// Driven against a stub backend, so the loop's own behaviour is pinned without
// spending a real session on it.

import { runAgent, createAgentSession } from '../src/agent.mjs';
import { readTask, lineQueue } from '../src/cli.mjs';
import { EventEmitter } from 'node:events';

function stubClient(replies) {
  const prompts = [];
  return {
    prompts,
    sessions: 0,
    async createSession() { this.sessions++; return `sess-${this.sessions}`; },
    async *stream({ prompt }) {
      prompts.push(prompt);
      const text = replies.shift() ?? 'Nothing left to do.';
      yield { type: 'message_id', id: `m${prompts.length}` };
      for (const chunk of text.match(/[\s\S]{1,7}/g) ?? []) yield { type: 'content', text: chunk };
    },
  };
}

const nullUI = () => ({
  step() {}, thinkingStart() {}, thinking() {}, prose() {},
  endTurn() {}, toolOk() {}, toolError() {}, skipped() {},
});

const writeTag = (path, body) => `<clichat:write path="${path}">\n${body}\n</clichat:write>`;

test('runs a tool, feeds the result back, and stops on prose', async () => {
  const root = sandbox();
  const client = stubClient([writeTag('a.txt', 'hello'), 'All done.']);
  const session = createAgentSession(root);

  const res = await runAgent({ client, task: 'make a.txt', session, ui: nullUI() });

  assert.equal(res.done, true);
  assert.equal(res.steps, 2);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'hello');
  assert.match(client.prompts[1], /<clichat:result tool="write" status="ok">/);
});

test('the tool instructions are sent once, not with every task', async () => {
  const root = sandbox();
  const client = stubClient(['ok.', 'ok.']);
  const session = createAgentSession(root);

  await runAgent({ client, task: 'first task', session, ui: nullUI() });
  await runAgent({ client, task: 'second task', session, ui: nullUI() });

  assert.match(client.prompts[0], /TOOLS/);
  assert.match(client.prompts[0], /TASK: first task/);
  assert.equal(client.prompts[1], 'second task', 'the preamble was resent');
  assert.equal(client.sessions, 1, 'a second session was created');
});

test('a follow-up keeps the same session and parent message', async () => {
  const root = sandbox();
  const client = stubClient(['ok.', 'ok.']);
  const session = createAgentSession(root);

  await runAgent({ client, task: 'one', session, ui: nullUI() });
  const after = session.parentMessageId;
  await runAgent({ client, task: 'two', session, ui: nullUI() });

  assert.equal(session.sessionId, 'sess-1');
  assert.notEqual(session.parentMessageId, after, 'the chain did not advance');
});

test('the step cap stops a model that will not stop', async () => {
  const root = sandbox();
  const client = stubClient(Array(50).fill(writeTag('a.txt', 'again')));
  const res = await runAgent({
    client, task: 'loop forever', session: createAgentSession(root),
    maxSteps: 4, ui: nullUI(),
  });
  assert.equal(res.done, false);
  assert.equal(res.steps, 4);
});

test('a declined write is not applied, and the model is told', async () => {
  const root = sandbox();
  const client = stubClient([writeTag('nope.txt', 'x'), 'understood.']);
  await runAgent({
    client, task: 'write it', session: createAgentSession(root),
    approve: async () => false, ui: nullUI(),
  });
  assert.equal(existsSync(join(root, 'nope.txt')), false);
  assert.match(client.prompts[1], /declined/);
});

test('a tool error is fed back so the model can recover', async () => {
  const root = sandbox();
  const client = stubClient(['<clichat:read path="missing.txt"/>', 'I see.']);
  await runAgent({ client, task: 'read it', session: createAgentSession(root), ui: nullUI() });
  assert.match(client.prompts[1], /status="error"/);
  assert.match(client.prompts[1], /no such file/);
});

test('an unterminated tag is reported rather than half-applied', async () => {
  const root = sandbox();
  const client = stubClient(['<clichat:write path="a.txt">\nhalf a fi', 'sorry.']);
  await runAgent({ client, task: 'go', session: createAgentSession(root), ui: nullUI() });
  assert.equal(existsSync(join(root, 'a.txt')), false);
  assert.match(client.prompts[1], /never closed/);
});

// ------------------------------------------------------------ task input

const stubInput = (lines) => ({ next: async () => lines.shift() });

test('a plain line is the task', async () => {
  assert.equal(await readTask(stubInput(['fix the bug']), '> '), 'fix the bug');
});

test('a trailing backslash continues onto the next line', async () => {
  assert.equal(await readTask(stubInput(['first \\', 'second \\', 'third']), '> '),
    'first \nsecond \nthird');
});

test('a triple quote opens a block that another one closes', async () => {
  const lines = ['"""', 'line one', '', '  indented', '"""', 'ignored'];
  assert.equal(await readTask(stubInput(lines), '> '), 'line one\n\n  indented');
});

test('a pasted block keeps characters that would need escaping elsewhere', async () => {
  const lines = ['"""', 'use /[^\\w]/g and "quotes"', 'and a \\ backslash', '"""'];
  assert.equal(await readTask(stubInput(lines), '> '), 'use /[^\\w]/g and "quotes"\nand a \\ backslash');
});

test('the line queue keeps input typed while the agent was busy', async () => {
  // The bug this exists for: rl.question() registers for the NEXT line only, so
  // a follow-up typed during a long step was emitted with nobody listening and
  // silently dropped -- and the session then ended at EOF.
  const rl = new EventEmitter();
  const q = lineQueue(rl);

  rl.emit('line', 'typed while busy');      // nobody is waiting yet
  rl.emit('line', 'and another');

  assert.equal(await q.next(), 'typed while busy');
  assert.equal(await q.next(), 'and another');
});

test('the line queue still resolves a line that arrives later', async () => {
  const rl = new EventEmitter();
  const q = lineQueue(rl);
  const pending = q.next();
  rl.emit('line', 'arrived after the ask');
  assert.equal(await pending, 'arrived after the ask');
});

test('the line queue rejects once input closes, which ends the session', async () => {
  const rl = new EventEmitter();
  const q = lineQueue(rl);
  rl.emit('close');
  await assert.rejects(() => q.next(), /input closed/);
});

test('a whole session can be piped in, queued ahead of time', async () => {
  const rl = new EventEmitter();
  const q = lineQueue(rl);
  for (const l of ['first task', '"""', 'a block', 'of text', '"""', '/exit']) rl.emit('line', l);

  assert.equal(await readTask(q, ''), 'first task');
  assert.equal(await readTask(q, ''), 'a block\nof text');
  assert.equal(await readTask(q, ''), '/exit');
});
