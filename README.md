# palmifer

Drive your real, logged-in Chrome from an agent CLI. Zero dependencies, no
browser extension.

```bash
palmifer status
palmifer open "https://example.com"
palmifer snapshot                    # accessibility tree with @eN refs
palmifer fill @e10 "search terms"    # @eN comes from the snapshot above
palmifer click "button[type=submit]"
palmifer screenshot /tmp/page.png
```

## Why

An agent often needs the user's own session — SSO, 2FA, or content that only
appears when signed in. Extension-based bridges solve that by adding a browser
extension; this does it with a debugging endpoint Chrome already provides.

Chrome 136+ refuses `--remote-debugging-port` on the default profile. Chrome 155
adds a per-instance opt-in that writes its port to `DevToolsActivePort`. This tool
speaks CDP to that endpoint, and keeps one long-lived daemon connection, because
Chrome asks for approval per connecting client — so it asks once, not per command.

## Install

```bash
git clone https://github.com/kjx-talesofai/claude-skill-palmifer.git ~/.agents/skills/palmifer
~/.agents/skills/palmifer/bin/palmifer.mjs status
```

Enable the endpoint once per browser session:

    chrome://inspect/#remote-debugging → "Allow remote debugging for this browser instance"

Requires Node >= 22 (built-in `fetch` and `WebSocket`). There is no npm install.

## Commands

The full command and flag list lives in [SKILL.md](SKILL.md) — one place,
so the two cannot drift.

### Fast path

Node's startup is most of a CLI call; the daemon round trip itself is ~10 ms.
`bin/palmifer` is a bash+curl+jq shim that skips Node entirely:

```bash
brog status                 # ~40 ms
brog snapshot --actionable-only
brog eval "document.title"
```

### Context cost

A full `snapshot` of a content-heavy page is ~15 KB (~5k tokens);
`--actionable-only` roughly a third less. Prefer `eval` with `JSON.stringify`
for reading data — one round trip, a few hundred bytes.

## Notes

- Loopback only. The daemon strips `HTTP(S)_PROXY` / `ALL_PROXY` /
  `NODE_USE_ENV_PROXY` from its own environment: with `NODE_USE_ENV_PROXY=1`,
  Node routes even `127.0.0.1` sockets through an outbound proxy and the
  handshake hangs silently.
- The opt-in is per browser instance and resets when Chrome restarts. Chrome
  shows a "being controlled by automated test software" banner while it is on.
- Daemon state and logs live in `~/.cache/palmifer/`.

MIT.
