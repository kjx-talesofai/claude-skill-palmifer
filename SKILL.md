---
name: palmifer
description: "Drive the user's real Chrome with their logins, or a throwaway headless one, over CDP — navigate, read, click, fill, screenshot."
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

## Which browser

| You want | Use | Why |
|---|---|---|
| the user's sessions | (default) | their real Chrome, their logins |
| unattended / no window / no opt-in / CI | `browser` | palmifer starts its own Chrome in a fresh temp profile, headless; no login, nothing of theirs in it |
| a logged-in browser that stays logged in | `browser --profile-dir <dir>` | same, but the profile is kept: log in once, survive restarts (`browser close` deletes only the temp ones) |
| to test or scrape without touching their cookies | `anon on` | a cookie-less context inside the browser already in use (its own window) |

`browser` needs no approval click; `browser --headed` shows the window,
`browser close` stops it (gracefully, so the profile is flushed) and deletes a
temp profile, `browser use real|private` switches back and forth,
`browser --dry-run` prints the exact Chrome command line without launching
anything. `anon off` closes the anonymous tabs and returns to the normal
profile. Say which one you used if the choice affects the user's account.

## Commands

| Command | Does |
|---|---|
| `status` / `tabs` / `frames` | browser version, tabs, iframes (`#fN`) |
| `use <n\|id\|url>` | select a tab |
| `open <url>` / `goto <url>` | new tab / navigate the current one |
| `snapshot` | accessibility tree with `@eN` refs (`--actionable-only`, `--filter`, `--limit`) |
| `text` | visible text of the page or a frame |
| `click <@eN\|css>` / `click --text <label>` | interact; `--text` finds the control by what it says (shadow roots included) |
| `fill <@eN\|css> <value>` | type into a field with real input events |
| `press <Enter\|Tab\|Escape\|ArrowDown\|Meta+A>` | one real key event |
| `scroll <down\|up\|bottom\|top>` | real wheel events (`--amount N`, `--times N`); bottom/top repeat until the page stops moving |
| `front` | raise this tab — input only reaches a visible tab |
| `dom <css>` / `dom --text <str>` | structural probe; lists matches with tag/text/rect, piercing shadow roots |
| `eval '<js>'` | run JS, return the value |
| `wait <css>` / `wait --text <str>` / `wait --js '<expr>'` | wait until content appears (`--timeout ms`) |
| `upload <@eN\|css> <file...>` | set a file input |
| `screenshot [path] [--full]` / `pdf [path]` | capture to a file |
| `network start\|list\|detail\|stop` | capture requests and bodies |
| `cdp <Domain.method> ['{json}']` | raw CDP (`--browser` = browser level) |
| `anon <on\|off\|status>` | cookie-less context, no logins |
| `browser [url] [--headed] [--profile-dir <dir>] [--dry-run]` | the browser palmifer starts itself |
| `browser status\|close\|use <real\|private>` | its lifecycle, and which one is active |
| `close [tab] [--mine\|--all]` | close tabs (refuses to close the last one unless `--force`) |
| `stop` | stop the local daemon |
| `bench [--runs N] [--json] [--cold]` | measure real latency; read-only |
| `mem` | daemon memory (heap after a forced GC) |

Flags: `--tab`, `--frame`, `--limit`, `--max`, `--timeout`, `--full`, `--browser`,
`--port`, `--fast`, `--headed`, `--profile-dir`, `--dry-run`, `--chrome <path>`,
plus `--text` / `--js` / `--nth` / `--exact` (matching) and `--amount` / `--times`
(scrolling).
`--frame` applies to `snapshot`, `text`, `eval` and `wait`; the other commands act
on the top document and say so if a frame is requested.

## On a headless server

No display, nobody to click *Allow*: run palmifer's own browser and keep its
profile, so a login survives restarts.

```bash
palmifer browser --profile-dir ~/.palmifer-profile https://example.com
palmifer snapshot --actionable-only        # it is now the active browser
palmifer browser close                     # stops it, keeps the profile
```

Needs Node >= 22 and a Chrome/Chromium (`PALMIFER_CHROME=/path/to/chrome` if it
is not in the usual place). On Linux the launch flags adapt themselves: root and
kernels without unprivileged user namespaces get `--no-sandbox`, and a `/dev/shm`
under 512 MB gets `--disable-dev-shm-usage`. `PALMIFER_CHROME_FLAGS` adds
anything else (`--lang=zh-CN --window-size=1280,900`; install CJK fonts or
screenshots of Chinese pages come out as boxes). The daemon binds `127.0.0.1`
only, so run the agent on the same machine. `palmifer browser --dry-run` shows
the exact command line if a launch fails.

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

## Read the page, do not fetch the site

The single most important rule here. **Do not use `eval` + `fetch()` to call the
site's own APIs.** That is not driving a browser, it is scraping through one:

- it skips the page, so it is exactly what the site's rate limits and risk
  control are built to catch (bilibili answers with HTML and a 412 after a while,
  which then parses as "SyntaxError: Unexpected token '<'");
- it wastes the one thing this tool has that a scraper does not: a real session
  behaving like a real page load;
- and it makes every later failure look like a bug in the site.

Reading the **rendered DOM** is what the page itself does, and is what stays
within the site's expectations. `eval` may read anything; it should not call out.

`eval` warns when the code contains `fetch(`/`XMLHttpRequest`/`sendBeacon`/
`WebSocket(`. When a network call is genuinely the point, pass `--allow-network`.

Reading costs, in tokens: `snapshot` on a content-heavy page ≈ 5k; `eval`
returning compact JSON ≈ 50–300; `dom --limit 10` ≈ 200.

1. Use `dom --text "<label>"` or `dom "<css>"` to find out what a page is made of
   — it pierces shadow roots, so it works on web-component sites where
   `document.querySelector` sees an empty shell.
2. Prefer `eval` returning a small JSON summary when you know where the data is.
   Page state is often in a global store (e.g. `window.__INITIAL_STATE__`).
3. `snapshot --actionable-only --limit 60` when you need to interact.
4. `@eN` refs die on navigation and on the next snapshot.

## Driving a paginated list

The pattern that works on SPA lists (and the one that produced a 152-video
collection from a real bilibili page without a single raw CDP call):

```bash
palmifer goto "https://site/list?page=1" --fast
palmifer dom ".item" --limit 5                    # learn the card shape once
palmifer eval '[...document.querySelectorAll(".item")].map(e=>({t:e.innerText}))'   # read the page
palmifer click --text "下一页"                     # real click, label-only buttons included
palmifer wait --js 'document.querySelectorAll(".item")[0].innerText!=="'$old'"'     # until it changed
```

Then loop. Three rules keep it honest: read what rendered (never the API), let
`scroll`/`click` send the real events, and keep the loop state in your own file
so a run can be resumed.

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
- Chrome only feeds input to the tab it is showing: `scroll`/`click`/`fill`/`press`
  refuse a hidden tab instead of hanging 60 s. Run `palmifer front` to raise it.
- Closing the last tab leaves Chrome with no window at all; `close` refuses that
  unless you pass `--force`.
- Modern sites hide content in nested web components. `dom`, `click --text`,
  `wait --text` and the accessibility snapshot see through open shadow roots; a
  hand-written `document.querySelector` does not.

## Notes

- Every request carries the token the daemon writes to `~/.cache/palmifer/token` (0600) on first run; non-loopback hosts and untokened requests are rejected.
- Daemon on `127.0.0.1:8798` (override `PALMIFER_DAEMON_PORT`); state and logs
  in `~/.cache/palmifer/`. A command error never kills the daemon.
- Proxy environment variables are stripped at startup: the tool only talks to
  loopback, and `NODE_USE_ENV_PROXY=1` routes even `127.0.0.1` sockets through an
  outbound proxy, where the handshake hangs.
