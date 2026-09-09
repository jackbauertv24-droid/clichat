// Solves DeepSeek's "DeepSeekHashV1" proof-of-work challenge.
//
// The browser loads a wasm-bindgen module (sha3_wasm_bg.wasm) and calls its
// wasm_solve export; we run that exact module here rather than reimplementing
// the hash, so the solver cannot drift out of sync with the server.
//
// wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)
// writes a 16-byte struct at retptr: an i32 status, then an f64 answer at +8.
// Status 0 means no solution was found.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WASM_PATH = fileURLToPath(
  new URL('../vendor/sha3_wasm_bg.7b9ca65ddd.wasm', import.meta.url),
);

let instance;

function load() {
  if (instance) return instance;
  const mod = new WebAssembly.Module(readFileSync(WASM_PATH));
  instance = new WebAssembly.Instance(mod, {});
  return instance;
}

function writeString(exports, text) {
  const bytes = Buffer.from(text, 'utf8');
  const ptr = exports.__wbindgen_export_0(bytes.length, 1);
  new Uint8Array(exports.memory.buffer).set(bytes, ptr);
  return [ptr, bytes.length];
}

// Returns the integer answer, or null if the module reports no solution.
export function solveHash({ challenge, salt, difficulty, expire_at }) {
  const { exports } = load();
  const prefix = `${salt}_${expire_at}_`;
  const retptr = exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    const [challengePtr, challengeLen] = writeString(exports, challenge);
    const [prefixPtr, prefixLen] = writeString(exports, prefix);

    exports.wasm_solve(
      retptr, challengePtr, challengeLen, prefixPtr, prefixLen, Number(difficulty),
    );

    // Re-read the view each time: allocation above may have grown memory.
    const view = new DataView(exports.memory.buffer);
    const status = view.getInt32(retptr, true);
    if (status === 0) return null;
    return Math.trunc(view.getFloat64(retptr + 8, true));
  } finally {
    exports.__wbindgen_add_to_stack_pointer(16);
  }
}

// Builds the base64 payload for the X-Ds-Pow-Response header.
export function powHeader(challenge) {
  const answer = solveHash(challenge);
  if (answer === null) {
    throw new Error('proof-of-work solver found no answer for the challenge');
  }
  return Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  })).toString('base64');
}

// DeepSeekHashV1 over a single string, as the browser computes it. Note this is
// a custom Keccak variant, NOT standard SHA3-256 -- a stock sha3 library gives
// different digests. Exposed so the solver can be verified end to end.
export function deepseekHash(text) {
  const { exports } = load();
  const retptr = exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    const [ptr, len] = writeString(exports, text);
    exports.wasm_deepseek_hash_v1(retptr, ptr, len);
    const view = new DataView(exports.memory.buffer);
    const outPtr = view.getInt32(retptr, true);
    const outLen = view.getInt32(retptr + 4, true);
    return Buffer.from(new Uint8Array(exports.memory.buffer, outPtr, outLen)).toString('utf8');
  } finally {
    exports.__wbindgen_add_to_stack_pointer(16);
  }
}
