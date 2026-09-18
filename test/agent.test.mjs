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
