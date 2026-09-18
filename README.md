# clichat

A terminal client for **chat.deepseek.com** — the web app backend, not the paid
`api.deepseek.com` service. It talks to your real DeepSeek account, so it uses
that account's conversation history and quota.

Zero dependencies; Node 20+ (built-in `fetch`, `readline`, `WebAssembly`).

## Install

```sh
npm install       # postinstall fetches DeepSeek's hasher and verifies its SHA-256
npm link          # or just: node bin/clichat.mjs ...
clichat auth
```

The proof-of-work hasher is **not** redistributed here -- it is DeepSeek's asset.
`scripts/fetch-wasm.mjs` downloads it from their CDN and refuses to install
anything whose digest does not match the pin in that file. Re-run it any time
with `npm run fetch-wasm`; `CLICHAT_SKIP_WASM_DOWNLOAD=1` makes install a no-op
for offline or CI environments.

## Use

```sh
clichat tui                   # full-screen chat UI
clichat code "add a test"     # agent loop: reads and writes files
clichat serve                 # OpenAI-compatible API on localhost
clichat                       # line-by-line interactive session
clichat "explain CRDTs"       # one-shot
git diff | clichat "review this"
clichat -t "prove sqrt2 is irrational"   # thinking model
clichat -s "what shipped in Node 24?"    # web search
```

In-session commands: `/new` `/think` `/search` `/clear` `/help` `/exit`.

### The TUI

`clichat tui` is a full-screen client: a status line, a scrolling transcript,
and a pinned input line. Reasoning output streams dimmed above the answer.

| key | does |
| --- | --- |
| `enter` | send |
| `ctrl-c` | stop the running stream; again (on an empty line) to quit |
| `pgup` / `pgdn` | scroll the transcript |
| `ctrl-l` | jump back to the latest |
| `up` / `down` | input history |
| `ctrl-a` / `ctrl-e` / `ctrl-w` / `ctrl-u` | readline-style line editing |

It is written against raw ANSI with no TUI dependency, repaints are coalesced to
~25fps so a fast token stream does not thrash the terminal, and it restores the
terminal on exit and on crash.

## The agent (`clichat code`)

`clichat code "<task>"` is a native agent loop. The model is given four tools
— `read`, `edit`, `write`, `list` — and keeps going until it answers without
calling one.

```sh
clichat code                                    # interactive session
clichat code "add a --json flag to bin/cli.js"  # one task, then exit
clichat code -i "start with the failing test"   # one task, then stay
clichat code --root ../other-project -y "fix the failing test"
clichat code --web                              # also serve it as a page
clichat code --resume                           # pick the last one back up
```

### Sessions

With no task, `clichat code` starts a session and keeps the conversation, so a
follow-up lands in a model that still remembers what it just read:

```
> create greet.js with an exported hello(name)
  * write greet.js (3 lines)  created greet.js (3 lines, 59 bytes)

> now add a goodbye(name) to that same file
  * read greet.js  export function hello(name) {
  * edit greet.js (1 block)  edited greet.js (1 block, +4 lines)
```

The tool instructions are sent once per session rather than with every task —
the backend is stateful, so repeating them would pay twice for context it
already has.

| command | |
| --- | --- |
| `/new` | forget the conversation and start fresh |
| `/yes` | toggle confirming each write |
| `/think` | toggle the reasoning model |
| `/steps N` | set the step cap |
| `/root` | show the workspace root |
| `/web` | whether the web view is running |
| `/exit` | leave |

A task worth giving an agent is often a paragraph, and argv is a poor place to
put one. End a line with `\` to continue it, or type `"""` alone to open a
block that another `"""` closes — the latter is what you want when pasting,
since it needs nothing added to each line.

```
> """
… Create config.js exporting a default object with:
…   - port: 8080
…   - host: "0.0.0.0"
… """
```

Input typed while the agent is working is kept, not dropped, so you can queue a
follow-up mid-step. A whole session can be piped in for the same reason.

#### Picking it back up

The conversation lives on DeepSeek's servers, keyed by a session id — which is
exactly why the agent can be sent a bare task and still remember the files it
read. But that id only ever existed in memory, so quitting threw away a
conversation the server was perfectly happy to continue.

```sh
clichat code --resume        # reattach to this directory's last conversation
clichat code --sessions      # what is saved, newest first
```

```
$ clichat code --resume
clichat code  /home/you/project
  resumed the session from 2 hours ago: add a --json flag to bin/cli.js
  the model still has the conversation; your terminal does not

> from memory, which files have you edited so far?
```

One session is remembered per workspace, in `sessions.json` beside your
credentials at mode `0600` — the labels quote your own prompts. **Only the
pointer is stored, never a transcript**, which is why nothing is replayed on
resume: the model has the history, your scrollback does not. `/new` abandons
the saved session as well as the live one, so `--resume` cannot reattach to a
conversation you have just walked away from.

The tool instructions are re-sent on resume even though the server still has
them. A session may be days old, and about a kilobyte is cheap insurance
against a model that has drifted.

### The web view

`clichat code --web` runs the ordinary terminal session **and** serves it as a
page. Both are live at once: the same stream renders in both, and either can
submit a task or answer a write confirmation.

```
$ clichat code --web
clichat code  /home/you/project
  web view  http://127.0.0.1:8787/#e5c280624b8e3ba3…
  that link is the credential; anything without it is refused
```

A single page, no build step and no CDN — the same choice `src/tui.mjs` makes in
writing raw ANSI rather than taking a dependency. Tool calls render as compact
rows, an approval is a card with **Approve** / **Decline**, and `Enter` sends
while `Shift+Enter` makes a new line, so a paragraph-long task needs no `"""`.

Whoever answers a confirmation first wins; the other side is told who settled it
and its buttons go dead. Reloading mid-run replays the transcript and carries on
streaming, because every event is indexed and the page reconnects with `?since=`.

It also runs with no terminal at all — useful from a detached shell:

```sh
clichat code --web --root ~/project    # drive it entirely from the browser
```

#### What guards it

This endpoint writes files, so it is held to a higher standard than `serve`,
which only spends quota:

- **Loopback only.** A non-local `--web-host` is refused outright. There is no
  `--api-key` style escape hatch, because the blast radius is your disk.
- **A per-run token**, carried in the URL's `#fragment` — which browsers never
  send to a server. It stays out of request lines, server logs and `Referer`
  headers. `GET /` is open because the document is inert without one.
- **POSTs require the token in a header**, not the body. A custom header cannot
  be sent cross-origin without a preflight, and no route answers one, so a
  hostile page in another tab cannot drive the agent even knowing the port.
- **No CORS at all**, unlike `serve`, which exists to be called by other tools.
- **The `Host` header is checked**, which is what stops DNS rebinding turning a
  public name into a loopback request.
- **`--web` with `-y` is refused**, since together they would mean anyone
  reaching the port writes files with no confirmation whatsoever.

All of the above is covered by tests that drive a real server on a real port.

```
-------------------- step 1/24
I'll read the file first.
  * read src/slug.js  // Turns a title into a URL slug.

-------------------- step 2/24
  * write src/slug.js (25 lines)  overwrote src/slug.js (25 lines, 676 bytes)

done in 3 steps
```

Each `write` is confirmed at the prompt unless you pass `-y`. `--max-steps` caps
the loop, at 24 by default.

### What stops a wrong path

The model was never trained to call tools, so sooner or later it will emit a path
that makes no sense. Confinement is what makes that a boring error rather than a
problem on your machine, and it is enforced in layers, because a path string on
its own cannot carry it:

1. The path is resolved against the **realpath** of the root and rejected if it
   lands outside — so `../`, an absolute path, and a symlinked directory in the
   middle are all refused.
2. A **symlink at the final component is refused outright** rather than followed.
   This is the subtle one. `existsSync` follows links, so a *dangling* symlink
   reads as "this leaf does not exist yet", resolves innocently against the root,
   and the write then follows it straight out of the workspace. Pinned by a test.
3. A **hard link** with more than one name is refused, since it shares an inode
   with a file realpath cannot see.
4. Anything that is not an ordinary file is refused — a fifo would hang the read
   forever, a device is not ours to touch.
5. After `mkdir`, the parent is re-resolved and re-checked, and the file is
   opened with **`O_NOFOLLOW`**, so a symlink that wins the race between the
   check and the open is refused by the kernel rather than by us.

The **root itself** is checked too: `clichat code` refuses to run with the
filesystem root, a system directory, or your home directory as its workspace,
since confinement to those is not a sandbox — it is the whole machine with a
longer prefix.

```
$ clichat code --root ~ "tidy my files"
refusing to use your home directory as a workspace root; run this inside a
project, or pass --root
```

A refusal is fed back to the model as a tool error, so it recovers and tries
something legal rather than failing the task:

```
  x write ../../ESCAPED.txt (1 lines)  path escapes the workspace root
  * write notes/hello.txt (1 lines)  created notes/hello.txt
```

There is still no shell tool, so none of this has to hold against code the model
gets to run — only against a path it gets to name.

### Why not just point an agent at `serve --emulate-tools`?

That was the original plan, and it works, but it pays for someone else's contract
twice. Tool schemas arrive as JSON Schema, which is verbose to restate in a
prompt, and the reply has to come back as JSON — the worst available format for
the thing an agent mostly does, which is emit the contents of a source file.
Every newline, quote and backslash has to survive escaping, and a model that was
never trained to call tools is exactly the model that gets that wrong.

Owning both ends removes the round trip. The grammar is an XML-ish tag whose body
is **raw**:

```
<clichat:write path="src/slug.js">
const RE = /[^\w\s-]/g;          // strip "punctuation" & symbols
return `=== "${slug(t)}" ===\n\tpath: C:\\site\\${slug(t)}`;
</clichat:write>
```

Nothing there needs escaping — regex literals, backslashes, nested quotes and
template strings all pass through byte for byte. The same content inside a JSON
`arguments` string is a minefield. `read` and `list` are self-closing:
`<clichat:read path="src/slug.js"/>`.

### Editing

`write` replaces a whole file, which is wasteful for a one-line change and
invites the model to garble the parts it was not asked to touch. `edit` takes
SEARCH/REPLACE blocks instead:

```
<clichat:edit path="src/server.js">
<<<<<<< SEARCH
const PORT = 3000;
=======
const PORT = process.env.PORT || 3000;
>>>>>>> REPLACE
</clichat:edit>
```

That grammar is chosen for the same reason as the tag: it is all over the
training data, so the model already knows the shape without being taught it.
Several blocks can go in one tag and are applied in order, and an empty REPLACE
deletes the lines.

**SEARCH must match exactly one place in the file.** If it matches none, or more
than one, the edit is refused and the model is told which — it is not applied to
a best guess. Quietly editing the wrong one of two matches is the failure this
is designed against, and it is the kind of thing you would not notice until much
later.

Two slips are tolerated, because they are the ones models actually make and
neither creates ambiguity: trailing whitespace, and a block quoted at the wrong
indentation. The indent has to be wrong *uniformly* — the same prefix added to
or removed from every line, which is what happens when a snippet gets
re-indented. The replacement is then re-indented to match the file. A
non-uniform mismatch is refused, since resolving it would be a guess.

Owning the loop also drops the statefulness problem that `serve` has to solve.
The OpenAI API is stateless, so the server keeps an LRU of conversation prefixes
to avoid resending the whole history each turn. chat.deepseek.com is stateful
natively, so the agent just sends the tool results and the session remembers the
rest.

Four verbs is deliberate. There is no shell tool — the model cannot run
anything, so the worst a confused reply can do is write a bad file inside the
root, and the confinement below only has to hold against a path the model
names, not against code it gets to execute.

The parser is the fragile part, so it is the tested part: `npm test` covers tag
extraction, streaming splits, and the path confinement.

## OpenAI-compatible server

`clichat serve` exposes the web backend as an OpenAI API, so existing tooling can
point at it unchanged:

```sh
clichat serve --port 8123
curl http://127.0.0.1:8123/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-reasoner","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8123/v1", api_key="unused")
client.chat.completions.create(model="deepseek-chat", messages=[...])
```

Routes: `POST /v1/chat/completions` (streaming and not), `GET /v1/models`,
`GET /health`. Models are `deepseek-chat` and `deepseek-reasoner`, each with a
`-search` variant; `deepseek-reasoner` returns its reasoning in
`reasoning_content`, matching DeepSeek's own API. An unrecognised model id
degrades to plain chat rather than erroring, since many clients hardcode names
like `gpt-4o`.

### Tool calling (`--emulate-tools`)

The web backend has no native function calling -- `tool_calls`, `function_call`
and `tool_choice` appear nowhere in its client bundle. But a tool call is only
structured text, so the bridge can emulate one:

```sh
clichat serve --emulate-tools
```

Outbound, the tool schemas are rendered into the prompt with an instruction to
reply with a marker followed by JSON. Inbound, that reply is parsed back into
real OpenAI `tool_calls` with `finish_reason: "tool_calls"`. Prior
`tool_calls` and `role: "tool"` messages in the history are serialised back to
text, so the agent loop -- call, run, feed the result back, answer -- works.

The marker exists to protect streaming: output is only withheld while the reply
could still turn out to be a call. Ordinary prose is recognised on its first
non-whitespace character and streams through untouched.

The parser is deliberately forgiving of what models actually emit: markdown
fences, a trailing comma, prose around the JSON, `arguments` as a string rather
than an object, and arrays for parallel calls. If the buffered text turns out
not to be a call, it is flushed through as prose rather than lost.

**Understand what this is.** The model was never trained to call tools, so it is
being asked to imitate a format. Expect it to be less reliable than a model with
native tool support, especially with large tool sets, and think carefully before
pointing a tool-using agent with write access at it. Emulation is off by default
and the plain chat path is untouched by it.

### Statefulness

The OpenAI API is stateless -- every request resends the full `messages` array --
but chat.deepseek.com is stateful, keyed by `chat_session_id` and
`parent_message_id`. Creating a session per request would throw away the
server-side conversation and resend the whole history as one prompt each time.

So the server keeps an LRU keyed by a hash of the conversation *prefix*. When a
client appends to `messages` (what every OpenAI client does), the prefix matches
and only the newest message is forwarded against the existing session. A cold
key falls back to flattening the history into a single prompt. This is invisible
to callers; it just means multi-turn chats stay cheap and keep their context.

Two caveats worth knowing:

- **`usage` counts are estimates.** The web backend reports no token usage, so
  the numbers are derived from character counts. Do not bill anyone from them.
- **Sampling parameters are ignored.** `temperature`, `top_p` and `max_tokens`
  have no equivalent in the web API, so they are accepted and dropped rather
  than silently faked. `tools` is dropped too unless `--emulate-tools` is set.

The server binds `127.0.0.1` by default and refuses a non-local `--host` unless
you also pass `--api-key`, since the port is a proxy for your DeepSeek account.

## Authenticating

`clichat auth` offers two routes:

1. **Paste a token** — DevTools → Application → Local Storage → `chat.deepseek.com`,
   key `userToken`, copy the `value` field.
2. **Email + password** — posts to `/api/v0/users/login` and keeps only the
   returned token.

The token is written to `$XDG_CONFIG_HOME/clichat/config.json` with mode `0600`.
The password is never stored.

## How it works

The web app guards `/api/v0/chat/completion` with a proof-of-work challenge:

1. `POST /api/v0/chat/create_pow_challenge` returns `{challenge, salt, difficulty,
   expire_at, signature}`. The server picked a secret nonce in `[0, difficulty)`
   and sends you `DeepSeekHashV1(salt_expireAt_nonce)`.
2. The client brute-forces that range to recover the nonce.
3. The answer goes back base64-encoded in the `X-Ds-Pow-Response` header.

`DeepSeekHashV1` is a **custom Keccak variant, not standard SHA3-256** — a stock
`sha3-256` produces different digests and every answer would be rejected. So
rather than reimplement it, the solver runs DeepSeek's own hasher directly in
Node (it imports nothing, so it needs no WASI shim). See Install for how that
binary is fetched and verified.

Verify the solver at any time:

```sh
npm run selftest    # forges challenges the way the server does, recovers each nonce
```

Typical solve is well under 100ms at the observed difficulty of 144000.

## Caveats

- **Unofficial.** These endpoints are private to the SPA and can change without
  notice. Automated access is outside DeepSeek's terms for the web service, and
  the account you point this at carries whatever risk that implies.
- **AWS WAF.** The HTML app sits behind a bot challenge; the JSON API currently
  answers without one. If that changes you'll get a clear error — pass a browser
  `aws-waf-token` cookie with `clichat auth --waf <cookie>`.
- **Two stream formats.** The server has shipped both an OpenAI-style
  `choices[].delta` form and a path-addressed `{v,p,o}` patch form. Both are
  handled; use `--debug` to dump raw events if output ever looks wrong.

## Layout

```
bin/clichat.mjs        entrypoint
src/pow.mjs            WASM proof-of-work solver + DeepSeekHashV1
src/client.mjs         endpoints, PoW retry, SSE parsing, cancellation
src/cli.mjs            arg parsing, REPL, one-shot
src/tui.mjs            full-screen chat UI
src/server.mjs         OpenAI-compatible HTTP front end
src/tools.mjs          prompt-based tool-call emulation (for serve)
src/agent.mjs          native agent loop: tag protocol, tool dispatch, sessions
src/hub.mjs            one session, several front ends: fan-out, queue, approvals
src/sessions.mjs       which conversation belongs to which workspace
src/webui.mjs          the web view's HTTP surface and its guards
src/webpage.mjs        that page, as one self-contained document
src/http.mjs           small helpers shared by both servers
src/fstools.mjs        read/edit/write/list, confined to a root directory
src/config.mjs         0600 credential storage
scripts/fetch-wasm.mjs downloads + verifies DeepSeek's hasher (not vendored)
test/                  node:test suite -- `npm test`
```

## Why there is no anonymous mode

The SPA has a "guest" proof-of-work path (`/api/v0/users/create_guest_challenge`),
which looks at first like anonymous access. It isn't. That endpoint validates the
`target_path` you ask a challenge for, and it accepts exactly two:

```
/api/v0/users/create_email_verification_code
/api/v0/users/create_sms_verification_code
```

Every chat path -- `chat/completion`, `chat_session/create`, and the other 36
endpoints in the bundle -- comes back `INVALID_TARGET_PATH`. Guest PoW is
anti-abuse on the one-time-code senders, i.e. it protects signup/login before you
have a token, not chatting without one. `chat_session/create` with no token
returns `Missing Token`, and no anonymous-login endpoint exists.

So a token is required, and `clichat auth` is not an avoidable step.

Those two endpoints are the passwordless login-by-code flow, so a future
`clichat auth --email-code` could sign in without a password. It would need the
guest PoW header (same solver, `biz_data.guest_challenge` instead of
`biz_data.challenge`) on the code request.
