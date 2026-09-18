// The tools the agent can actually run.
//
// Everything here is confined to a single root directory. The model is being
// asked to imitate a format it was never trained on, so it will occasionally
// emit a path that makes no sense; the confinement is what makes that boring
// instead of dangerous. Paths are resolved against the root and rejected if
// they land outside it, including by way of a symlink.

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync,
  existsSync, realpathSync,
} from 'node:fs';
import { resolve, dirname, relative, join, sep } from 'node:path';

const MAX_READ = 200_000;   // bytes; a file bigger than this is truncated
const MAX_ENTRIES = 400;    // directory entries per listing
const SKIP = new Set(['.git', 'node_modules', '.cache', 'dist', 'build']);

export class ToolError extends Error {}

// Resolves `p` inside `root`, refusing anything that escapes.
//
// The file itself may not exist yet (that is the point of `write`), so the
// realpath check walks up to the nearest ancestor that does exist: a symlink
// anywhere on the way out is still caught, without requiring the leaf.
export function safePath(root, p) {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError('no path given');
  if (p.includes('\0')) throw new ToolError('path contains a null byte');

  const rootReal = realpathSync(root);
  const target = resolve(rootReal, p);

  let probe = target;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const probeReal = realpathSync(probe);
  const rest = relative(probe, target);
  const resolved = rest ? join(probeReal, rest) : probeReal;

  if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
    throw new ToolError(`path escapes the workspace root: ${p}`);
  }
  return resolved;
}

export const tools = {
  read: {
    summary: 'read a file',
    describe: (a) => `read ${a.path}`,
    usage: '<clichat:read path="src/index.js"/>',
    run(ctx, a) {
      const full = safePath(ctx.root, a.path);
      if (!existsSync(full)) throw new ToolError(`no such file: ${a.path}`);
      if (statSync(full).isDirectory()) throw new ToolError(`${a.path} is a directory; use list`);
      const buf = readFileSync(full);
      const text = buf.subarray(0, MAX_READ).toString('utf8');
      return buf.length > MAX_READ
        ? `${text}\n... [truncated at ${MAX_READ} bytes of ${buf.length}]`
        : text;
    },
  },

  write: {
    body: true,
    summary: 'create or overwrite a file',
    describe: (a, body) => `write ${a.path} (${body.split('\n').length} lines)`,
    usage: '<clichat:write path="src/index.js">\nthe complete file contents\n</clichat:write>',
    mutates: true,
    run(ctx, a, body) {
      const full = safePath(ctx.root, a.path);
      if (existsSync(full) && statSync(full).isDirectory()) {
        throw new ToolError(`${a.path} is a directory`);
      }
      mkdirSync(dirname(full), { recursive: true });
      const existed = existsSync(full);
      writeFileSync(full, body);
      const lines = body.split('\n').length;
      return `${existed ? 'overwrote' : 'created'} ${a.path} (${lines} lines, ${Buffer.byteLength(body)} bytes)`;
    },
  },

  list: {
    summary: 'list a directory',
    describe: (a) => `list ${a.path || '.'}`,
    usage: '<clichat:list path="src"/>',
    run(ctx, a) {
      const full = safePath(ctx.root, a.path || '.');
      if (!existsSync(full)) throw new ToolError(`no such directory: ${a.path}`);
      if (!statSync(full).isDirectory()) throw new ToolError(`${a.path} is a file; use read`);

      const out = [];
      for (const e of readdirSync(full, { withFileTypes: true }).sort(byName)) {
        if (SKIP.has(e.name)) continue;
        if (e.isDirectory()) { out.push(`${e.name}/`); continue; }
        let size = '';
        try { size = `  ${statSync(join(full, e.name)).size}b`; } catch { /* raced */ }
        out.push(`${e.name}${size}`);
        if (out.length >= MAX_ENTRIES) { out.push(`... [truncated]`); break; }
      }
      return out.length ? out.join('\n') : '(empty)';
    },
  },
};

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
