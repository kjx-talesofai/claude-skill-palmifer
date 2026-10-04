---
name: palmifer
description: "Control the user's real Chrome, with their logins, over CDP — navigate, read, click, fill, screenshot."
---

# palmifer

Runs the browser the user is already signed into, over raw CDP — no extension,
no MCP server, no account. It is a CLI: call it with bash and read stdout.

- `bin/palmifer.mjs` — Node ≥ 22, zero dependencies
- `bin/palmifer` — the same commands through curl+jq (≈40 ms per call)

## Setup

Chrome must expose a debugging endpoint for that browser instance:

    chrome://inspect/#remote-debugging → "Allow remote debugging for this browser instance"

A daemon holds the connection, so Chrome asks for approval once per daemon start
rather than once per command. Check it first:

    ~/.agents/skills/palmifer/bin/palmifer status

If it reports a missing endpoint, give the user that line (in their language),
let them enable it, and retry.

## Commands

| Command | Does |
|---|---|
| `status` / `tabs` / `frames` | browser version, tabs, iframes (`#fN`) |
| `use <n\|id\|url>` | select a tab |
| `open <url>` / `goto <url>` | new tab / navigate the current one |
| `snapshot` | accessibility tree with `@eN` refs (`--actionable-only`, `--filter`, `--limit`) |
| `text` | visible text of the page or a frame |
| `click <@eN\|css>` / `fill <@eN\|css> <value>` | interact |
| `eval '<js>'` | run JS, return the value |
| `wait <css>` / `wait --text <str>` | wait until content appears |
| `upload <@eN\|css> <file...>` | set a file input |
| `screenshot [path] [--full]` / `pdf [path]` | capture to a file |
| `network start\|list\|detail\|stop` | capture requests and bodies |
| `cdp <Domain.method> ['{json}']` | raw CDP (`--browser` = browser level) |
| `close [tab] [--mine\|--all]` | close tabs |
| `stop` | stop the local daemon |
| `bench [--runs N] [--json] [--cold]` | measure real latency; read-only |

Flags: `--tab`, `--frame`, `--limit`, `--max`, `--timeout`, `--full`, `--browser`,
`--port`, `--fast`. `--frame` applies to `snapshot`, `text`, `eval` and `wait`; the
other commands act on the top document and say so if a frame is requested.

## Defaults

Actions are paced the way a person using the browser is paced: real input events,
an eased pointer path, character-by-character typing, a pause after navigation,
spacing between actions, and a burst cap. This is the default; `--fast` drops the
pauses for read-only commands or when the user asks for speed.

The first command against a new host prints a one-line notice. Relay it once, in
the user's language ("acting on <host> with human-paced defaults; say faster to
skip"), then carry on.

If a site pushes back — a verification prompt, a rate limit, an action that
silently disappears — stop and tell the user instead of retrying.

## Reading pages cheaply

`snapshot` is the expensive call (a content-heavy page ≈ 5k tokens); `eval`
returning compact JSON is ≈ 50–300.

1. Prefer `eval` when you know where the data lives. Page state is often in a
   global store (e.g. `window.__INITIAL_STATE__`), and most sites expose JSON
   endpoints the page can `fetch` with the user's own session.
2. Use `snapshot --actionable-only --limit 60` when you need to interact.
3. `@eN` refs die on navigation and on the next snapshot.

## Gotchas

- Prefer the site's own links and controls over hand-built deep links.
- Pages that check `event.isTrusted` ignore synthetic `el.click()`; the default
  already sends real input events, so only `--fast` runs into this.
- A selector matching a zero-size element is rejected rather than clicked at (0, 0).
- Reactive lists re-render: resolve and act in one call.
- `chrome://` tabs work, but their target id can change after load — select by URL.
- `--frame` fails loudly when nothing matches; cross-origin frames need their own
  execution context.
- `target="_blank"` links can be popup-blocked: read the `href`, then `open` it.
- Tab groups are not exposed by CDP; use `close --mine` and tab order.

## Notes

- Every request carries the token the daemon writes to `~/.cache/palmifer/token` (0600) on first run; non-loopback hosts and untokened requests are rejected.
- Daemon on `127.0.0.1:8798` (override `PALMIFER_DAEMON_PORT`); state and logs
  in `~/.cache/palmifer/`. A command error never kills the daemon.
- Proxy environment variables are stripped at startup: the tool only talks to
  loopback, and `NODE_USE_ENV_PROXY=1` routes even `127.0.0.1` sockets through an
  outbound proxy, where the handshake hangs.
