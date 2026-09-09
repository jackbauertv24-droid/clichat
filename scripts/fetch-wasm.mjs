#!/usr/bin/env node
// Fetches DeepSeek's DeepSeekHashV1 hasher from their CDN and verifies it against
// a pinned SHA-256. The binary is not redistributed with this repo; it is their
// asset, and reimplementing the hash is not an option (it is a custom Keccak
// variant, so a stock sha3-256 produces answers the server rejects).
//
//   npm run fetch-wasm            fetch if missing or mismatched
//   CLICHAT_WASM_URL=...          override the source
//   CLICHAT_WASM_SHA256=...       expected digest, if you are pinning a new build
//   CLICHAT_SKIP_WASM_DOWNLOAD=1  no-op (for offline/CI installs)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const URL_DEFAULT = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
const SHA256 = 'b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d';
const DEST = fileURLToPath(new URL('../vendor/sha3_wasm_bg.7b9ca65ddd.wasm', import.meta.url));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function ok(msg) { process.stdout.write(`clichat: ${msg}\n`); }
function warn(msg) { process.stderr.write(`clichat: ${msg}\n`); }

// Postinstall must never break a consumer's install; the CLI reports a clear
// error later if the file is genuinely absent.
function bail(msg, { fatal }) {
  warn(msg);
  warn('run `npm run fetch-wasm` once you have network access');
  process.exit(fatal ? 1 : 0);
}

async function main() {
  const fatal = process.argv.includes('--strict');

  if (process.env.CLICHAT_SKIP_WASM_DOWNLOAD) {
    ok('skipping wasm download (CLICHAT_SKIP_WASM_DOWNLOAD set)');
    return;
  }

  if (existsSync(DEST)) {
    const have = sha256(readFileSync(DEST));
    if (have === SHA256) { ok('wasm already present and verified'); return; }
    warn(`existing wasm has unexpected digest ${have.slice(0, 16)}..., refetching`);
  }

  const url = process.env.CLICHAT_WASM_URL || URL_DEFAULT;
  let res;
  try {
    res = await fetch(url, { headers: { referer: 'https://chat.deepseek.com/' } });
  } catch (err) {
    bail(`could not reach ${url}: ${err.message}`, { fatal });
    return;
  }

  if (res.status === 404) {
    warn(`${url} is gone -- DeepSeek has rotated the asset hash.`);
    warn('find the current filename with:');
    warn('  curl -s -X POST https://chat.deepseek.com/api/v0/__probe__ -d "{}" \\');
    warn('    -H "Content-Type: application/json" | grep -oE "main\\.[a-f0-9]+\\.js"');
    warn('then grep that bundle for sha3_wasm and update URL_DEFAULT/SHA256 here.');
    bail('cannot fetch a pinned wasm', { fatal });
    return;
  }
  if (!res.ok) { bail(`HTTP ${res.status} fetching ${url}`, { fatal }); return; }

  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);

  const expected = process.env.CLICHAT_WASM_SHA256 || SHA256;
  if (got !== expected) {
    warn('refusing to install: digest mismatch');
    warn(`  expected ${expected}`);
    warn(`  received ${got}`);
    warn('the upstream asset changed; verify it before updating the pin.');
    process.exit(1); // always fatal: this one is a trust failure, not a network blip
  }

  mkdirSync(dirname(DEST), { recursive: true });
  writeFileSync(DEST, buf);
  ok(`fetched ${buf.length} bytes, sha256 verified (${got.slice(0, 16)}...)`);
}

main().catch((err) => { warn(err.message); process.exit(0); });
