import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { DeepSeekWebClient, DeepSeekError } from './client.mjs';
import { loadConfig, saveConfig, configPath } from './config.mjs';
import { solveHash, deepseekHash } from './pow.mjs';
import { ChatTUI } from './tui.mjs';

const HELP = `clichat -- talk to chat.deepseek.com from the terminal

USAGE
  clichat                      start a line-by-line interactive session
  clichat tui                  start the full-screen chat UI
  clichat "your question"      ask once and print the answer
  echo "question" | clichat    read the prompt from stdin
  clichat auth                 sign in and store a token
  clichat pow-selftest         verify the proof-of-work solver

OPTIONS
  -t, --think      enable the reasoning model (thinking output)
  -s, --search     enable web search
      --new        force a fresh conversation
      --debug      dump raw server events to stderr
  -h, --help       show this help

AUTH
  clichat auth --token <jwt>   store a bearer token directly
  clichat auth --waf <cookie>  store an aws-waf-token cookie, if challenged
  Config is written to ${configPath} (mode 0600).

TUI KEYS
  enter send · ctrl-c stop stream or quit · pgup/pgdn scroll
  up/down input history · ctrl-l jump to latest · ctrl-w delete word

IN-SESSION COMMANDS
  /new      start a fresh conversation      /think    toggle thinking
  /search   toggle web search               /exit     quit
`;

function parseArgs(argv) {
  const opts = { think: false, search: false, debug: false, fresh: false, words: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-t' || a === '--think') opts.think = true;
    else if (a === '-s' || a === '--search') opts.search = true;
    else if (a === '--debug') opts.debug = true;
    else if (a === '--new') opts.fresh = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--waf') opts.waf = argv[++i];
    else opts.words.push(a);
  }
  return opts;
}

const dim = (s) => (stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

async function readStdin() {
  if (stdin.isTTY) return null;
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text || null;
}

async function cmdAuth(opts) {
  if (opts.token || opts.waf) {
    const patch = {};
    if (opts.token) patch.token = opts.token.replace(/^Bearer\s+/i, '');
    if (opts.waf) patch.wafCookie = opts.waf;
    saveConfig(patch);
    stdout.write(`Saved to ${configPath}\n`);
    return;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(
      'Two ways to authenticate:\n'
      + '  1. Paste a token from the browser (DevTools > Application > Local Storage\n'
      + '     on chat.deepseek.com, key "userToken", field "value")\n'
      + '  2. Sign in with your email and password\n\n',
    );
    const choice = (await rl.question('Choose [1/2]: ')).trim();

    if (choice === '2') {
      const email = (await rl.question('Email: ')).trim();
      const password = await rl.question('Password (input is visible): ');
      const client = new DeepSeekWebClient({});
      const token = await client.login({ email, password });
      saveConfig({ token });
      stdout.write(`\nSigned in. Token saved to ${configPath}\n`);
    } else {
      const token = (await rl.question('Token: ')).trim().replace(/^Bearer\s+/i, '');
      if (!token) throw new Error('no token entered');
      saveConfig({ token });
      stdout.write(`\nToken saved to ${configPath}\n`);
    }
  } finally {
    rl.close();
  }
}

function cmdPowSelftest() {
  // Reproduces the server's construction: pick a nonce, hash prefix+nonce, then
  // confirm the solver recovers that nonce from the hash alone.
  const salt = 'a1b2c3d4e5f60718';
  const expire_at = 1789000000000;
  const difficulty = 144000;
  const prefix = `${salt}_${expire_at}_`;
  let pass = 0;
  for (const secret of [0, 1, 7331, 98765, 143999]) {
    const t = Date.now();
    const got = solveHash({ challenge: deepseekHash(prefix + secret), salt, difficulty, expire_at });
    const ok = got === secret;
    if (ok) pass++;
    stdout.write(`  nonce ${String(secret).padStart(6)} -> ${String(got).padStart(6)}  `
      + `${ok ? 'ok' : 'FAILED'}  ${dim(`${Date.now() - t}ms`)}\n`);
  }
  stdout.write(`\n${pass}/5 recovered${pass === 5 ? '' : ' -- solver is broken'}\n`);
  return pass === 5 ? 0 : 1;
}


async function runTurn(client, state, prompt, opts) {
  let mode = '';
  let wroteThinking = false;
  let assistant = '';

  for await (const ev of client.stream({
    sessionId: state.sessionId,
    parentMessageId: state.parentMessageId,
    prompt,
    thinking: opts.think,
    search: opts.search,
  })) {
    if (ev.type === 'message_id') { state.parentMessageId = ev.id; continue; }
    if (ev.type === 'thinking') {
      if (mode !== 'thinking') {
        stdout.write(dim('\nthinking\n'));
        mode = 'thinking';
        wroteThinking = true;
      }
      stdout.write(dim(ev.text));
    } else if (ev.type === 'content') {
      if (mode !== 'content') {
        stdout.write(wroteThinking ? '\n\n' : '');
        mode = 'content';
      }
      stdout.write(ev.text);
      assistant += ev.text;
    }
  }
  stdout.write('\n');
  return assistant;
}

async function ensureSession(client, state) {
  if (!state.sessionId) state.sessionId = await client.createSession();
  return state.sessionId;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  const sub = opts.words[0];

  if (opts.help) { stdout.write(HELP); return 0; }
  if (sub === 'help') { stdout.write(HELP); return 0; }
  if (sub === 'auth') { await cmdAuth(opts); return 0; }
  if (sub === 'pow-selftest') return cmdPowSelftest();

  const cfg = loadConfig();
  if (!cfg.token) {
    stderr.write('Not authenticated. Run `clichat auth` first.\n');
    return 1;
  }

  const client = new DeepSeekWebClient({
    token: cfg.token, wafCookie: cfg.wafCookie, debug: opts.debug,
  });
  const state = { sessionId: null, parentMessageId: null };

  if (sub === 'tui') {
    const tui = new ChatTUI({ client, state, opts });
    try {
      await tui.run();
    } finally {
      tui.cleanup();
    }
    return 0;
  }

  const piped = await readStdin();
  const oneShot = [piped, opts.words.join(' ').trim()].filter(Boolean).join('\n').trim();

  if (oneShot) {
    await ensureSession(client, state);
    await runTurn(client, state, oneShot, opts);
    return 0;
  }

  stdout.write(bold('clichat') + dim('  /new /think /search /exit\n\n'));
  const rl = createInterface({ input: stdin, output: stdout, historySize: 500 });
  try {
    for (;;) {
      let line;
      try {
        line = await rl.question(bold('> '));
      } catch {
        break; // ctrl-c / ctrl-d
      }
      const text = line.trim();
      if (!text) continue;
      if (text === '/exit' || text === '/quit') break;
      if (text === '/new') {
        state.sessionId = null; state.parentMessageId = null;
        stdout.write(dim('started a new conversation\n'));
        continue;
      }
      if (text === '/think') {
        opts.think = !opts.think;
        stdout.write(dim(`thinking ${opts.think ? 'on' : 'off'}\n`));
        continue;
      }
      if (text === '/search') {
        opts.search = !opts.search;
        stdout.write(dim(`search ${opts.search ? 'on' : 'off'}\n`));
        continue;
      }
      if (text === '/help') { stdout.write(HELP); continue; }

      try {
        await ensureSession(client, state);
        await runTurn(client, state, text, opts);
      } catch (err) {
        if (err instanceof DeepSeekError) stderr.write(`\n${err.message}\n`);
        else stderr.write(`\n${err.message}\n`);
      }
      stdout.write('\n');
    }
  } finally {
    rl.close();
  }
  return 0;
}
