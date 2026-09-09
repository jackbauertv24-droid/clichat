// Credentials live in $XDG_CONFIG_HOME/clichat/config.json (0600).
// Only the bearer token is persisted -- never the account password.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'clichat');
const FILE = join(DIR, 'config.json');

export const configPath = FILE;

export function loadConfig() {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    throw new Error(`config at ${FILE} is not valid JSON; delete it and re-authenticate`);
  }
}

export function saveConfig(patch) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const merged = { ...loadConfig(), ...patch };
  writeFileSync(FILE, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  chmodSync(FILE, 0o600); // enforce even if the file already existed
  return merged;
}
