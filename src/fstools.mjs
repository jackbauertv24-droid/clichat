// The tools the agent can actually run.
//
// Everything here is confined to a single root directory. The model is being
// asked to imitate a format it was never trained on, so it will occasionally
// emit a path that makes no sense; the confinement is what makes that boring
// instead of dangerous.
//
// Confinement is enforced three times over, because a path string alone cannot
// carry it:
//
//   1. `safePath` resolves the path against the realpath of the root and
//      rejects anything landing outside, including via a symlinked directory
//      in the middle, and refuses outright when the final component is itself
//      a symlink. That last part matters: `existsSync` follows links, so a
//      DANGLING symlink reads as "this leaf does not exist yet" and resolves
//      innocently against the root -- and then the write follows it straight
//      out of the workspace.
//   2. Before writing, the parent directory is re-resolved after `mkdir` and
//      re-checked, so a link cannot be introduced part way through.
//   3. The file is opened with O_NOFOLLOW, so even if a symlink wins the race
//      between the check and the open, the kernel refuses it.
//
// Nothing here executes anything. The worst a confused reply can do is write a
// bad file inside the root.

import {
  readFileSync, readdirSync, lstatSync, statSync, mkdirSync,
  openSync, closeSync, writeSync, readSync, fstatSync, realpathSync, constants,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, basename, relative, join, sep, parse } from 'node:path';

const MAX_READ = 200_000;   // bytes; a file bigger than this is truncated
const MAX_ENTRIES = 400;    // directory entries per listing
const SKIP = new Set(['.git', 'node_modules', '.cache', 'dist', 'build']);

// Roots where confinement would be meaningless. Handing the agent your home
// directory is not a sandbox, it is the whole problem with a longer prefix.
const FORBIDDEN_ROOTS = new Set([
  '/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev',
  '/proc', '/sys', '/var', '/opt', '/root', '/home', '/srv', '/run',
]);

export class ToolError extends Error {}

// Validates the workspace root itself, before any tool runs.
export function resolveRoot(dir) {
  let real;
  try {
    real = realpathSync(resolve(dir));
  } catch {
    throw new ToolError(`no such directory: ${dir}`);
  }
  if (!statSync(real).isDirectory()) throw new ToolError(`not a directory: ${dir}`);
  if (FORBIDDEN_ROOTS.has(real) || real === parse(real).root) {
    throw new ToolError(`refusing to use ${real} as a workspace root`);
  }
  if (real === realpathSync(homedir())) {
    throw new ToolError(
      'refusing to use your home directory as a workspace root; '
      + 'run this inside a project, or pass --root',
    );
  }
  return real;
}

// True if the path exists at all, INCLUDING a symlink whose target does not.
// `existsSync` follows links and would answer false for a dangling one.
function lexists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

function assertInside(rootReal, resolved, shown) {
  if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
    throw new ToolError(`path escapes the workspace root: ${shown}`);
  }
}

// Resolves `p` inside `root`, refusing anything that escapes.
//
// The file itself may not exist yet (that is the point of `write`), so the
// realpath check walks up to the nearest existing ancestor of its PARENT: a
// symlinked directory anywhere on the way out is caught, without requiring the
// leaf. The leaf is handled separately, by refusing to touch a symlink at all.
export function safePath(root, p) {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError('no path given');
  if (p.includes('\0')) throw new ToolError('path contains a null byte');

  const rootReal = realpathSync(root);
  const target = resolve(rootReal, p);

  // Resolve the parent chain through any symlinks it contains.
  let probe = dirname(target);
  while (!lexists(probe) && dirname(probe) !== probe) probe = dirname(probe);
  let probeReal;
  try {
    probeReal = realpathSync(probe);
  } catch {
    throw new ToolError(`cannot resolve path: ${p}`);   // dangling link in the chain
  }
  const rest = relative(probe, dirname(target));
  const parentReal = rest ? join(probeReal, rest) : probeReal;
  const resolved = target === rootReal ? rootReal : join(parentReal, basename(target));

  assertInside(rootReal, resolved, p);

  // A symlink at the leaf is refused rather than followed. Inside a workspace
  // it is almost always a mistake, and it is the one case the checks above
  // cannot see through.
  if (lexists(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new ToolError(`refusing to follow the symlink at ${p}`);
  }
  return resolved;
}

// Opens `full` for reading or writing without following a final symlink, and
// refuses anything that is not an ordinary file (a fifo would hang the read, a
// device is not ours to touch).
function openRegular(full, shown, { write = false } = {}) {
  if (lexists(full)) {
    const st = lstatSync(full);
    if (st.isDirectory()) throw new ToolError(`${shown} is a directory`);
    if (!st.isFile()) throw new ToolError(`${shown} is not an ordinary file`);
    // A hard link shares its inode with a name elsewhere, which realpath cannot
    // see. Overwriting it would change that other file too.
    if (write && st.nlink > 1) {
      throw new ToolError(`${shown} is a hard link with ${st.nlink} names; refusing to write`);
    }
  }
  const flags = (write ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC
    : constants.O_RDONLY) | constants.O_NOFOLLOW;
  try {
    return openSync(full, flags, 0o644);
  } catch (err) {
    if (err.code === 'ELOOP') throw new ToolError(`refusing to follow the symlink at ${shown}`);
    if (err.code === 'ENOENT') throw new ToolError(`no such file: ${shown}`);
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new ToolError(`permission denied: ${shown}`);
    throw err;
  }
}

export const tools = {
  read: {
    summary: 'read a file',
    describe: (a) => `read ${a.path}`,
    usage: '<clichat:read path="src/index.js"/>',
    run(ctx, a) {
      const full = safePath(ctx.root, a.path);
      const fd = openRegular(full, a.path);
      try {
        const size = fstatSync(fd).size;
        const buf = Buffer.alloc(Math.min(size, MAX_READ));
        readSync(fd, buf, 0, buf.length, 0);
        const text = buf.toString('utf8');
        return size > MAX_READ
          ? `${text}\n... [truncated at ${MAX_READ} bytes of ${size}]`
          : text;
      } finally {
        closeSync(fd);
      }
    },
  },

  write: {
    body: true,
    summary: 'create or overwrite a file',
    describe: (a, body) => `write ${a.path} (${body.split('\n').length} lines)`,
    usage: '<clichat:write path="src/index.js">\nthe complete file contents\n</clichat:write>',
    mutates: true,
    run(ctx, a, body) {
      const rootReal = realpathSync(ctx.root);
      const full = safePath(rootReal, a.path);
      const existed = lexists(full);

      mkdirSync(dirname(full), { recursive: true });
      // mkdir happened after the check, so confirm the parent is still ours.
      assertInside(rootReal, realpathSync(dirname(full)), a.path);

      const fd = openRegular(full, a.path, { write: true });
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      const lines = body.split('\n').length;
      return `${existed ? 'overwrote' : 'created'} ${a.path} `
        + `(${lines} lines, ${Buffer.byteLength(body)} bytes)`;
    },
  },

  list: {
    summary: 'list a directory',
    describe: (a) => `list ${a.path || '.'}`,
    usage: '<clichat:list path="src"/>',
    run(ctx, a) {
      const shown = a.path || '.';
      const full = safePath(ctx.root, shown);
      if (!lexists(full)) throw new ToolError(`no such directory: ${shown}`);
      if (!lstatSync(full).isDirectory()) throw new ToolError(`${shown} is a file; use read`);

      const out = [];
      for (const e of readdirSync(full, { withFileTypes: true }).sort(byName)) {
        if (SKIP.has(e.name)) continue;
        if (e.isDirectory()) { out.push(`${e.name}/`); continue; }
        if (e.isSymbolicLink()) { out.push(`${e.name}  (symlink, not followed)`); continue; }
        let size = '';
        try { size = `  ${lstatSync(join(full, e.name)).size}b`; } catch { /* raced */ }
        out.push(`${e.name}${size}`);
        if (out.length >= MAX_ENTRIES) { out.push('... [truncated]'); break; }
      }
      return out.length ? out.join('\n') : '(empty)';
    },
  },
};

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
