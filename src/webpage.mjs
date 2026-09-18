// The web view, as one self-contained document.
//
// Inline CSS and JS, no CDN and no build step -- the same choice src/tui.mjs
// makes in writing raw ANSI rather than taking a TUI dependency. The page has
// to work on a machine with no network beyond the DeepSeek call itself.
//
// The token is NOT baked in here. The page reads it from its own URL fragment,
// so it never appears in the document body, in a Referer header, or in a
// server log of the request line.

export const page = () => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>clichat code</title>
<style>
  :root {
    --bg: #fbfbfa; --fg: #21201c; --dim: #6b6a66; --line: #e4e2dd;
    --card: #fff; --accent: #2f6f4e; --bad: #a33; --warn: #8a6d1f;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #17171a; --fg: #e8e6e1; --dim: #9a9892; --line: #2c2c31;
      --card: #1e1e22; --accent: #7fc4a0; --bad: #e08b8b; --warn: #d6b45f;
    }
  }
  :root[data-theme="dark"] {
    --bg: #17171a; --fg: #e8e6e1; --dim: #9a9892; --line: #2c2c31;
    --card: #1e1e22; --accent: #7fc4a0; --bad: #e08b8b; --warn: #d6b45f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.55 system-ui, -apple-system, Segoe UI, sans-serif;
    display: flex; flex-direction: column; height: 100dvh;
  }
  header {
    display: flex; align-items: center; gap: .6rem;
    padding: .7rem 16px; border-bottom: 1px solid var(--line);
    font-family: var(--mono); font-size: 13px;
  }
  header .root { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header .spacer { flex: 1 }
  .dot { width: .6rem; height: .6rem; border-radius: 50%; background: var(--dim); flex: none; }
  .dot.live { background: var(--accent); }
  .dot.busy { background: var(--warn); animation: pulse 1s infinite; }
  .dot.gone { background: var(--bad); }
  @keyframes pulse { 50% { opacity: .35 } }

  main { flex: 1; overflow-y: auto; padding: 1rem 16px 2rem; }
  .wrap { max-width: 46rem; margin: 0 auto; }

  .task {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: .55rem .8rem; margin: 1.4rem 0 .9rem; white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .task .who { color: var(--dim); font-family: var(--mono); font-size: 12px; }
  .prose { white-space: pre-wrap; overflow-wrap: anywhere; margin: .3rem 0; }
  .think { color: var(--dim); font-size: 13px; white-space: pre-wrap; margin: .3rem 0; }
  .step { color: var(--dim); font-family: var(--mono); font-size: 12px; margin: 1rem 0 .3rem; }

  .tool {
    font-family: var(--mono); font-size: 13px; display: flex; gap: .5rem;
    padding: .18rem 0; overflow-wrap: anywhere;
  }
  .tool .mark { flex: none; width: 1rem; }
  .tool.ok .mark { color: var(--accent); }
  .tool.error .mark { color: var(--bad); }
  .tool.skipped { color: var(--dim); }
  .tool .out { color: var(--dim); }

  .ask {
    background: var(--card); border: 1px solid var(--warn); border-radius: 10px;
    padding: .7rem .8rem; margin: .6rem 0; font-family: var(--mono); font-size: 13px;
  }
  .ask .row { display: flex; gap: .5rem; margin-top: .6rem; flex-wrap: wrap; }
  button {
    font: inherit; font-family: var(--mono); padding: .35rem .9rem; cursor: pointer;
    border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--fg);
  }
  button.yes { border-color: var(--accent); color: var(--accent); }
  button.no { border-color: var(--bad); color: var(--bad); }
  button:disabled { opacity: .45; cursor: default; }
  .settled { color: var(--dim); margin-top: .5rem; }
  .err { color: var(--bad); font-family: var(--mono); font-size: 13px; margin: .4rem 0; }

  footer { border-top: 1px solid var(--line); padding: .7rem 16px; }
  form { max-width: 46rem; margin: 0 auto; display: flex; gap: .5rem; align-items: flex-end; }
  textarea {
    flex: 1; resize: none; font: inherit; padding: .5rem .7rem; border-radius: 9px;
    border: 1px solid var(--line); background: var(--card); color: var(--fg);
    min-height: 2.6rem; max-height: 40vh;
  }
  .hint { max-width: 46rem; margin: .4rem auto 0; color: var(--dim); font-size: 12px; }
</style>

<header>
  <span class="dot" id="dot"></span>
  <b>clichat code</b>
  <span class="root" id="root"></span>
  <span class="spacer"></span>
  <span class="root" id="state"></span>
</header>

<main><div class="wrap" id="log"></div></main>

<footer>
  <form id="form">
    <textarea id="input" rows="1" placeholder="type a task…" autofocus></textarea>
    <button type="submit" id="send">send</button>
  </form>
  <div class="hint">enter sends · shift+enter for a new line</div>
</footer>

<script>
(() => {
  // The token rides in the fragment, which browsers never send to the server.
  const token = location.hash.slice(1);
  const log = document.getElementById('log');
  const dot = document.getElementById('dot');
  const state = document.getElementById('state');
  const input = document.getElementById('input');
  const form = document.getElementById('form');

  let seen = 0;              // highest event index applied
  let proseEl = null;        // the paragraph currently being streamed into
  let thinkEl = null;
  const asks = new Map();    // id -> element

  const atBottom = () => {
    const m = document.querySelector('main');
    return m.scrollHeight - m.scrollTop - m.clientHeight < 60;
  };
  const scroll = (was) => {
    if (was) requestAnimationFrame(() => {
      const m = document.querySelector('main');
      m.scrollTop = m.scrollHeight;
    });
  };
  const el = (cls, text) => {
    const d = document.createElement('div');
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    log.appendChild(d);
    return d;
  };

  function apply(e) {
    if (e.i !== undefined) { if (e.i < seen) return; seen = e.i + 1; }
    const was = atBottom();

    switch (e.type) {
      case 'status':
        document.getElementById('root').textContent = e.root || '';
        dot.className = 'dot ' + (e.busy ? 'busy' : 'live');
        state.textContent = e.busy
          ? ('working' + (e.queued ? ' · ' + e.queued + ' queued' : ''))
          : 'idle';
        break;
      case 'task': {
        const d = el('task');
        const who = document.createElement('div');
        who.className = 'who';
        who.textContent = '> from the ' + (e.by || 'web');
        d.appendChild(who);
        d.appendChild(document.createTextNode(e.text));
        proseEl = thinkEl = null;
        break;
      }
      case 'step':
        el('step', '── step ' + e.n + '/' + e.max);
        proseEl = thinkEl = null;
        break;
      case 'thinking':
        if (!thinkEl) thinkEl = el('think', '');
        thinkEl.textContent += e.text;
        break;
      case 'prose':
        if (!proseEl) proseEl = el('prose', '');
        proseEl.textContent += e.text;
        break;
      case 'endTurn':
        proseEl = thinkEl = null;
        break;
      case 'tool': {
        const d = el('tool ' + e.status);
        const mark = document.createElement('span');
        mark.className = 'mark';
        mark.textContent = e.status === 'ok' ? '▸' : e.status === 'error' ? '✕' : '–';
        const label = document.createElement('span');
        label.textContent = e.label;
        d.appendChild(mark); d.appendChild(label);
        if (e.output) {
          const out = document.createElement('span');
          out.className = 'out';
          out.textContent = e.output.split('\\n')[0].slice(0, 90);
          d.appendChild(out);
        }
        proseEl = thinkEl = null;
        break;
      }
      case 'ask': {
        const d = el('ask');
        d.appendChild(document.createTextNode('? ' + e.label));
        const row = document.createElement('div');
        row.className = 'row';
        const yes = document.createElement('button');
        yes.className = 'yes'; yes.textContent = 'Approve';
        const no = document.createElement('button');
        no.className = 'no'; no.textContent = 'Decline';
        yes.onclick = () => answer(e.id, true);
        no.onclick = () => answer(e.id, false);
        row.appendChild(yes); row.appendChild(no);
        d.appendChild(row);
        asks.set(e.id, d);
        proseEl = thinkEl = null;
        break;
      }
      case 'answer': {
        const d = asks.get(e.id);
        if (d) {
          d.querySelectorAll('button').forEach((b) => { b.disabled = true; });
          const s = document.createElement('div');
          s.className = 'settled';
          s.textContent = (e.ok ? 'approved' : 'declined')
            + (e.by === 'web' ? '' : ' at the ' + e.by);
          d.appendChild(s);
          asks.delete(e.id);
        }
        break;
      }
      case 'done':
        el('step', e.ok ? ('done in ' + e.steps + ' step' + (e.steps === 1 ? '' : 's'))
                        : ('stopped after ' + e.steps + ' steps without finishing'));
        proseEl = thinkEl = null;
        break;
      case 'error':
        el('err', e.message);
        break;
      default:
        break;
    }
    scroll(was);
  }

  async function post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clichat-token': token },
      body: JSON.stringify(body),
    });
    if (!r.ok) apply({ type: 'error', message: path + ': ' + r.status + ' ' + (await r.text()) });
    return r.ok;
  }

  const answer = (id, ok) => post('/answer', { id, ok });

  form.onsubmit = (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    post('/task', { text });
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
  });

  // Reconnects with ?since= so a dropped stream resumes rather than duplicating.
  let es = null;
  function connect() {
    if (es) es.close();
    es = new EventSource('/events?since=' + seen + '&token=' + encodeURIComponent(token));
    es.onmessage = (m) => { try { apply(JSON.parse(m.data)); } catch (_) {} };
    es.onopen = () => { dot.classList.remove('gone'); };
    es.onerror = () => {
      dot.className = 'dot gone';
      state.textContent = 'reconnecting…';
      es.close();
      setTimeout(connect, 1200);
    };
  }
  if (!token) {
    el('err', 'No token in the URL. Open the link clichat printed, including the #… part.');
  } else {
    connect();
  }
})();
</script>
</html>`;
