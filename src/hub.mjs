// One agent session, several front ends.
//
// The terminal and the browser are both live at once, so everything they have
// to agree on lives here rather than in either of them:
//
//   - the transcript, so a browser opening or reloading mid-run can catch up
//     (the terminal has scrollback; a fresh tab has nothing);
//   - a task queue, so two inputs cannot start two tasks at once;
//   - the outstanding approval, which either side may answer -- first answer
//     wins and the other side is told who settled it.
//
// The hub emits plain JSON events. A sink is just a function; the terminal sink
// wraps the ANSI renderer, each SSE client is another. Nothing here knows what
// a terminal or a browser is.

const MAX_TRANSCRIPT = 5000;   // events; a long session is trimmed from the front

export class SessionHub {
  constructor({ root, run }) {
    this.root = root;
    this.run = run;                 // async (task, {ui, approve}) => void
    this.transcript = [];
    this.dropped = 0;               // events trimmed off the front, so indexes stay honest
    this.sinks = new Set();
    this.queue = [];
    this.busy = false;
    this.pending = null;            // {id, label, resolve}
    this.nextId = 1;
    this.draining = null;           // the in-flight drain, so callers can await it
  }

  // ------------------------------------------------------------- fan-out

  attach(sink) {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  emit(event) {
    const e = { ...event, i: this.dropped + this.transcript.length };
    this.transcript.push(e);
    if (this.transcript.length > MAX_TRANSCRIPT) {
      this.dropped += this.transcript.length - MAX_TRANSCRIPT;
      this.transcript = this.transcript.slice(-MAX_TRANSCRIPT);
    }
    for (const sink of this.sinks) {
      try { sink(e); } catch { /* one bad sink must not stop the others */ }
    }
    return e;
  }

  // Events from index `since` onward, for a client catching up.
  since(index) {
    const from = Math.max(0, (index ?? 0) - this.dropped);
    return this.transcript.slice(from);
  }

  status() {
    return {
      type: 'status',
      root: this.root,
      busy: this.busy,
      queued: this.queue.length,
      ask: this.pending ? { id: this.pending.id, label: this.pending.label } : null,
    };
  }

  // ------------------------------------------------------------ approvals

  // Resolves with true/false once anybody answers. Emitted as `ask`, settled
  // by `answer`.
  askApproval(label) {
    return new Promise((resolve) => {
      const id = `a${this.nextId++}`;
      this.pending = { id, label, resolve };
      this.emit({ type: 'ask', id, label });
    });
  }

  // Returns true if this call is the one that settled it. A second answer for
  // an id that is already settled is ignored rather than treated as an error:
  // both front ends can legitimately have the buttons up.
  answer(id, ok, by = 'web') {
    const p = this.pending;
    if (!p || p.id !== id) return false;
    this.pending = null;
    this.emit({ type: 'answer', id, ok: !!ok, by });
    p.resolve(!!ok);
    return true;
  }

  // --------------------------------------------------------------- tasks

  // Accepts a task from any front end. Runs it now if idle, else queues it.
  submit(text, by = 'web') {
    const task = String(text ?? '').trim();
    if (!task) return false;
    this.queue.push({ task, by });
    this.emit({ type: 'queued', text: task, by, queued: this.queue.length });
    this.drain();
    return true;
  }

  drain() {
    if (this.busy) return this.draining;
    this.draining = this.#drain();
    return this.draining;
  }

  // Resolves when the queue is empty. The terminal awaits this before printing
  // its next prompt, so a run's output does not interleave with the prompt.
  async settled() {
    while (this.draining) {
      const d = this.draining;
      await d;
      if (d === this.draining) { this.draining = null; break; }
    }
  }

  async #drain() {
    this.busy = true;
    try {
      while (this.queue.length) {
        const { task, by } = this.queue.shift();
        this.emit({ type: 'task', text: task, by });
        this.emit(this.status());
        try {
          await this.run(task, { ui: this.ui(), approve: (label) => this.askApproval(label) });
        } catch (err) {
          this.emit({ type: 'error', message: err?.message ?? String(err) });
        }
      }
    } finally {
      this.busy = false;
      // An approval cannot outlive its task; nothing would ever answer it.
      if (this.pending) this.answer(this.pending.id, false, 'system');
      this.emit(this.status());
    }
  }

  // The `ui` object runAgent expects, rendered as events instead of ANSI.
  ui() {
    return {
      step: (n, max) => this.emit({ type: 'step', n, max }),
      thinkingStart: () => this.emit({ type: 'thinkingStart' }),
      thinking: (text) => this.emit({ type: 'thinking', text }),
      prose: (text) => this.emit({ type: 'prose', text }),
      endTurn: () => this.emit({ type: 'endTurn' }),
      toolOk: (label, output) => this.emit({ type: 'tool', status: 'ok', label, output: String(output) }),
      toolError: (label, message) => this.emit({ type: 'tool', status: 'error', label, output: String(message) }),
      skipped: (label) => this.emit({ type: 'tool', status: 'skipped', label, output: '' }),
      done: (steps, ok) => this.emit({ type: 'done', steps, ok }),
    };
  }
}
