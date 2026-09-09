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
- **Sampling parameters are ignored.** `temperature`, `top_p`, `max_tokens`,
  `tools` and friends have no equivalent in the web API, so they are accepted
  and dropped rather than silently faked.

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
src/config.mjs         0600 credential storage
scripts/fetch-wasm.mjs downloads + verifies DeepSeek's hasher (not vendored)
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
