// Full-screen chat UI. Deliberately dependency-free: raw-mode stdin, ANSI
// escapes, and a full repaint per frame (throttled, so streaming stays smooth).
//
// Layout is three regions: a status line, a scrolling transcript, and an input
// line pinned to the bottom.

import { stdin, stdout } from 'node:process';
import { DeepSeekError } from './client.mjs';

const ESC = '\x1b';
const alt = { on: `${ESC}[?1049h`, off: `${ESC}[?1049l` };
const cursor = { hide: `${ESC}[?25l`, show: `${ESC}[?25h`, to: (r, c) => `${ESC}[${r};${c}H` };
const CLEAR_EOL = `${ESC}[K`;

const C = {
  reset: `${ESC}[0m`, dim: `${ESC}[2m`, bold: `${ESC}[1m`,
  cyan: `${ESC}[36m`, green: `${ESC}[32m`, red: `${ESC}[31m`, yellow: `${ESC}[33m`,
  inv: `${ESC}[7m`,
};

// Visible width, ignoring SGR sequences.
const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

function wrap(text, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (word === '') continue;
      if (visLen(line + word) <= width) { line += word; continue; }
      if (line.trim()) out.push(line.trimEnd());
      // A single word longer than the pane has to be hard-split.
      let w = word.trimStart();
      while (visLen(w) > width) { out.push(w.slice(0, width)); w = w.slice(width); }
      line = w;
    }
    if (line.trim() || out.length === 0) out.push(line.trimEnd());
  }
  return out;
}

export class ChatTUI {
  constructor({ client, state, opts }) {
    this.client = client;
    this.state = state;
    this.opts = opts;
    this.messages = [];        // {role:'user'|'assistant'|'system', text, thinking}
    this.input = '';
    this.caret = 0;
    this.history = [];
    this.histIdx = -1;
    this.scroll = 0;           // lines scrolled up from the bottom
    this.streaming = false;
    this.abort = null;
    this.spinnerAt = 0;
    this.dirty = true;
    this.lastPaint = 0;
    this.paintTimer = null;
  }

  get width() { return Math.max(20, stdout.columns || 80); }
  get height() { return Math.max(8, stdout.rows || 24); }
  get paneHeight() { return this.height - 3; } // status + separator + input

  // ---- rendering ----------------------------------------------------------

  transcriptLines() {
    const w = this.width - 2;
    const lines = [];
    for (const m of this.messages) {
      if (m.role === 'user') {
        for (const l of wrap(m.text, w - 2)) lines.push(`${C.cyan}${C.bold}> ${l}${C.reset}`);
      } else if (m.role === 'system') {
        for (const l of wrap(m.text, w)) lines.push(`${C.yellow}${l}${C.reset}`);
      } else {
        if (m.thinking) {
          for (const l of wrap(m.thinking, w)) lines.push(`${C.dim}${l}${C.reset}`);
          if (m.text) lines.push('');
        }
        for (const l of wrap(m.text, w)) lines.push(l);
      }
      lines.push('');
    }
    return lines;
  }

  statusLine() {
    const bits = [`${C.bold}clichat${C.reset}`];
    bits.push(this.state.sessionId
      ? `${C.dim}session ${String(this.state.sessionId).slice(0, 8)}${C.reset}`
      : `${C.dim}no session${C.reset}`);
    bits.push(`think ${this.opts.think ? `${C.green}on` : `${C.dim}off`}${C.reset}`);
    bits.push(`search ${this.opts.search ? `${C.green}on` : `${C.dim}off`}${C.reset}`);
    if (this.streaming) {
      const frames = ['|', '/', '-', '\\'];
      bits.push(`${C.yellow}${frames[this.spinnerAt++ % 4]} streaming${C.reset} ${C.dim}^C stops${C.reset}`);
    }
    if (this.scroll > 0) bits.push(`${C.inv} scrolled ${this.scroll} ${C.reset}`);
    return ' ' + bits.join(`${C.dim} · ${C.reset}`);
  }

  paint() {
    const H = this.height;
    const lines = this.transcriptLines();
    const pane = this.paneHeight;

    const maxScroll = Math.max(0, lines.length - pane);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    const start = Math.max(0, lines.length - pane - this.scroll);
    const view = lines.slice(start, start + pane);

    let out = cursor.hide + cursor.to(1, 1) + this.statusLine() + CLEAR_EOL;
    for (let i = 0; i < pane; i++) {
      out += cursor.to(2 + i, 1) + (view[i] ?? '') + CLEAR_EOL;
    }
    out += cursor.to(H - 1, 1) + C.dim + '─'.repeat(this.width) + C.reset + CLEAR_EOL;

    // Input line, horizontally scrolled to keep the caret visible.
    const prompt = this.streaming ? `${C.dim}… ${C.reset}` : `${C.green}❯ ${C.reset}`;
    const avail = this.width - 3;
    let shown = this.input;
    let caretCol = this.caret;
    if (caretCol > avail) { shown = this.input.slice(caretCol - avail); caretCol = avail; }
    out += cursor.to(H, 1) + prompt + shown.slice(0, avail) + CLEAR_EOL;
    out += cursor.to(H, 3 + caretCol) + cursor.show;

    stdout.write(out);
  }

  // Coalesce repaints so a fast token stream doesn't thrash the terminal.
  render() {
    this.dirty = true;
    const now = Date.now();
    if (now - this.lastPaint >= 40) {
      this.lastPaint = now;
      this.dirty = false;
      this.paint();
    } else if (!this.paintTimer) {
      this.paintTimer = setTimeout(() => {
        this.paintTimer = null;
        if (this.dirty) { this.lastPaint = Date.now(); this.dirty = false; this.paint(); }
      }, 40);
    }
  }

  say(text) { this.messages.push({ role: 'system', text }); this.render(); }

  // ---- input --------------------------------------------------------------

  handleKey(seq) {
    // Escape sequences first.
    if (seq === `${ESC}[A`) return this.recallHistory(-1);
    if (seq === `${ESC}[B`) return this.recallHistory(1);
    if (seq === `${ESC}[C`) { this.caret = Math.min(this.input.length, this.caret + 1); return this.render(); }
    if (seq === `${ESC}[D`) { this.caret = Math.max(0, this.caret - 1); return this.render(); }
    if (seq === `${ESC}[5~`) { this.scroll += this.paneHeight - 1; return this.render(); }
    if (seq === `${ESC}[6~`) { this.scroll = Math.max(0, this.scroll - (this.paneHeight - 1)); return this.render(); }
    if (seq === `${ESC}[H` || seq === `${ESC}[1~`) { this.caret = 0; return this.render(); }
    if (seq === `${ESC}[F` || seq === `${ESC}[4~`) { this.caret = this.input.length; return this.render(); }
    if (seq === `${ESC}[3~`) {
      this.input = this.input.slice(0, this.caret) + this.input.slice(this.caret + 1);
      return this.render();
    }

    const ch = seq;
    if (ch === '\r' || ch === '\n') return this.submit();
    if (ch === '\x7f' || ch === '\b') {
      if (this.caret > 0) {
        this.input = this.input.slice(0, this.caret - 1) + this.input.slice(this.caret);
        this.caret--;
      }
      return this.render();
    }
    if (ch === '\x03') return this.interrupt();          // ctrl-c
    if (ch === '\x04') return this.quit();               // ctrl-d
    if (ch === '\x0c') { this.scroll = 0; return this.render(); } // ctrl-l
    if (ch === '\x01') { this.caret = 0; return this.render(); }  // ctrl-a
    if (ch === '\x05') { this.caret = this.input.length; return this.render(); } // ctrl-e
    if (ch === '\x15') { this.input = this.input.slice(this.caret); this.caret = 0; return this.render(); }
    if (ch === '\x17') {                                  // ctrl-w
      const left = this.input.slice(0, this.caret).replace(/\s*\S+\s*$/, '');
      this.input = left + this.input.slice(this.caret);
      this.caret = left.length;
      return this.render();
    }
    if (ch < ' ' && ch !== '\t') return undefined;        // ignore other control bytes

    this.input = this.input.slice(0, this.caret) + ch + this.input.slice(this.caret);
    this.caret += ch.length;
    return this.render();
  }

  recallHistory(dir) {
    if (!this.history.length) return this.render();
    if (this.histIdx === -1 && dir < 0) this.histIdx = this.history.length - 1;
    else this.histIdx = Math.min(this.history.length - 1, Math.max(-1, this.histIdx + dir));
    this.input = this.histIdx === -1 ? '' : this.history[this.histIdx];
    this.caret = this.input.length;
    return this.render();
  }

  interrupt() {
    if (this.streaming && this.abort) { this.abort.abort(); return; }
    if (this.input) { this.input = ''; this.caret = 0; return this.render(); }
    return this.quit();
  }

  quit() { this.running = false; this.cleanup(); process.exit(0); }

  // ---- turn handling ------------------------------------------------------

  async submit() {
    const text = this.input.trim();
    if (this.streaming || !text) return;
    this.input = ''; this.caret = 0; this.histIdx = -1; this.scroll = 0;

    if (text.startsWith('/')) { this.history.push(text); return this.command(text); }

    this.history.push(text);
    this.messages.push({ role: 'user', text });
    const turn = { role: 'assistant', text: '', thinking: '' };
    this.messages.push(turn);
    this.render();

    this.streaming = true;
    this.abort = new AbortController();
    let errored = false;
    try {
      if (!this.state.sessionId) this.state.sessionId = await this.client.createSession();
      for await (const ev of this.client.stream({
        sessionId: this.state.sessionId,
        parentMessageId: this.state.parentMessageId,
        prompt: text,
        thinking: this.opts.think,
        search: this.opts.search,
        signal: this.abort.signal,
      })) {
        if (ev.type === 'message_id') this.state.parentMessageId = ev.id;
        else if (ev.type === 'thinking') turn.thinking += ev.text;
        else if (ev.type === 'content') turn.text += ev.text;
        this.render();
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        turn.text += `${C.dim}\n[stopped]${C.reset}`;
      } else {
        errored = true;
        const msg = err instanceof DeepSeekError ? err.message : `error: ${err.message}`;
        this.messages.push({ role: 'system', text: msg });
      }
    } finally {
      this.streaming = false;
      this.abort = null;
      // A failed turn already shows its error; don't also leave an empty bubble.
      if (!turn.text && !turn.thinking) {
        if (errored) this.messages.splice(this.messages.indexOf(turn), 1);
        else turn.text = `${C.dim}[no content]${C.reset}`;
      }
      this.lastPaint = 0;
      this.render();
    }
    return undefined;
  }

  command(text) {
    const [cmd] = text.split(/\s+/);
    switch (cmd) {
      case '/new':
        this.state.sessionId = null; this.state.parentMessageId = null;
        this.messages = [];
        return this.say('started a new conversation');
      case '/think':
        this.opts.think = !this.opts.think;
        return this.say(`thinking ${this.opts.think ? 'on' : 'off'}`);
      case '/search':
        this.opts.search = !this.opts.search;
        return this.say(`search ${this.opts.search ? 'on' : 'off'}`);
      case '/clear':
        this.messages = [];
        return this.render();
      case '/exit': case '/quit':
        return this.quit();
      case '/help':
        return this.say(
          'commands: /new /think /search /clear /exit\n'
          + 'keys: enter send · ctrl-c stop or quit · pgup/pgdn scroll · '
          + 'up/down history · ctrl-l jump to latest',
        );
      default:
        return this.say(`unknown command ${cmd} (try /help)`);
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  cleanup() {
    if (this.paintTimer) clearTimeout(this.paintTimer);
    try { stdin.setRawMode(false); } catch { /* not a tty */ }
    stdout.write(cursor.show + alt.off);
  }

  async run() {
    if (!stdin.isTTY) throw new Error('the TUI needs an interactive terminal');
    this.running = true;
    stdout.write(alt.on);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onResize = () => { this.lastPaint = 0; this.render(); };
    stdout.on('resize', onResize);
    process.on('exit', () => this.cleanup());

    this.say('welcome to clichat — type a message, /help for commands');
    this.render();

    for await (const chunk of stdin) {
      // A paste or fast keypress can deliver several sequences at once.
      let rest = chunk;
      while (rest.length) {
        const m = rest.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
        if (m) { this.handleKey(m[0]); rest = rest.slice(m[0].length); continue; }
        this.handleKey(rest[0]);
        rest = rest.slice(1);
      }
      if (!this.running) break;
    }
    this.cleanup();
  }
}
