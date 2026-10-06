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
| `status` / `tabs` / `frames` | browser version, tabs, iframes (`#fN`); `status` answers even when the browser is gone (`reachable:false`) |
| `use <n\|id\|url>` | select a tab |
| `open <url>` / `goto <url>` | new tab / navigate the current one (`goto` reports the `previousUrl` it replaced) |
| `snapshot` | accessibility tree with `@eN` refs (`--actionable-only`, `--filter`, `--limit`) |
| `text` | visible text of the page or a frame |
| `click <@eN\|css>` / `click --text <label>` | interact; `--nth N` picks the Nth match (CSS or text), `--text` finds the control by what it says (shadow roots included) |
| `click-at <x> <y>` | trusted click at a point: the handle for a canvas, an icon-only control, or anything inside a frame (`--frame` makes the point frame-relative) |
| `fill <@eN\|css> <value>` | type into a field, replacing what is there |
| `type-at <x> <y> "<text>" [--append]` | click a point and type there; replaces unless `--append` |
| `press <Enter\|Tab\|Escape\|ArrowDown\|Meta+A>` | one real key event |
| `scroll <down\|up\|bottom\|top>` | real wheel events (`--amount N` in pixels, `--times N`); bottom/top repeat until the page stops moving. Reports `scrollY`, `moved`, `grewBy` |
| `front` | raise this tab — input only reaches a visible tab |
| `dom <css>` / `dom --text <str>` | structural probe; lists matches with tag/text/rect, piercing shadow roots (`--text` keeps the innermost match, `--all` adds the ancestors, `--within <css>` scopes it to a container) |
| `eval '<js>'` / `eval --file <path>` | run JS, return the value |
| `wait <css>` / `wait --text <str>` / `wait --js '<expr>'` | wait until content appears (`--timeout ms`) |
| `upload <@eN\|css> <file...>` | set a file input |
| `screenshot [path] [--full] [--scale N] [--max-width N] [--annotate]` / `pdf [path]` | capture to a file; the extension picks the format, `--annotate` draws the `@eN` numbers from the last snapshot |
| `network start\|list\|detail\|stop` | capture requests and bodies (`detail` takes the id or the row number from `list`) |
| `cdp <Domain.method> ['{json}']` | raw CDP (`--browser` = browser level) |
| `anon <on\|off\|status>` | cookie-less context, no logins |
| `browser [url] [--headed] [--profile-dir <dir>] [--dry-run]` | the browser palmifer starts itself |
| `browser status\|close\|use <real\|private>` | its lifecycle, and which one is active |
| `close [tab] [--mine\|--all]` | close tabs (refuses to close the last one unless `--force`) |
| `cancel` | stop the command the daemon is running, without dropping the Chrome approval |
| `stop` | stop the local daemon |
| `bench [--runs N] [--json] [--cold]` | measure real latency; read-only |
| `mem` | daemon memory (heap after a forced GC) |

Flags: `--tab`, `--frame`, `--limit`, `--max`, `--timeout`, `--full`, `--browser`,
`--port`, `--fast`, `--synthetic`, `--headed`, `--profile-dir`, `--dry-run`,
`--chrome <path>`, `--scale`, `--max-width`, `--quality`, `--annotate`, `--verify`,
plus `--text` / `--js` / `--nth` / `--exact` / `--within` (matching and scoping),
`--amount` / `--times` (scrolling) and `--front` (raise a hidden tab before
sending input).

`--frame` works on `snapshot`, `text`, `dom`, `eval`, `wait`, `click`, `fill`,
`upload`, `click-at` and `type-at`: the element or point is resolved inside that
frame and translated to page coordinates. Coordinates palmifer prints are page
coordinates; with `--frame` on `click-at`/`type-at` the ones you pass are
frame-relative. Same-origin frames are the supported case; a cross-origin frame
can still be read with `--frame` but not measured, and says so.

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
waiting for read-only commands or when the user asks for speed.

**`--fast` never changes what the page receives.** Real input events are always
used, because a page that checks `event.isTrusted` ignores `el.click()` and the
action then fails silently. `--synthetic` is the explicit opt-in for the
untrusted shortcut; every action reports which one it used (`"input":"real"` or
`"synthetic"`).

`click`, `fill`, `press`, `click-at` and `type-at` also report what changed around
the action, so a separate read-back is normally unnecessary:

```json
"effect": {"urlChanged": false, "titleChanged": false, "domDelta": 12, "requests": 1}
```

`domDelta` on a virtualised list is noisy by nature — treat the numbers as
signals, not proof. `--verify <css>` is the explicit form: it polls for up to 2 s
and answers `"verified": true|false`; a leading `!` asks for the element to be
gone (`--verify "!.spinner"`).

The first command against a new host prints a one-line notice. Relay it once, in
the user's language ("acting on <host> with human-paced defaults; say faster to
skip"), then carry on.

If a site pushes back — a verification prompt, a rate limit, an action that
silently disappears — stop and tell the user instead of retrying.

## Several agents on one machine

One daemon has one `current` tab, one `@eN` table and one action budget, so two
agents driving it will keep changing each other's tab. Give each agent its own
daemon and state directory; they can share the same Chrome:

```bash
export PALMIFER_STATE_DIR=~/.cache/palmifer-agent2
export PALMIFER_DAEMON_PORT=8799
```

Then pass `--tab` explicitly instead of relying on "current". A command whose
implicit `current` tab was closed elsewhere falls back to a live tab and says so;
an explicit `--tab` that cannot be resolved still fails.

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
- Pages that check `event.isTrusted` ignore synthetic `el.click()`: palmifer sends
  real input by default and under `--fast`, so this only comes up if you ask for
  `--synthetic` yourself.
- A selector matching a zero-size element is rejected rather than clicked at (0, 0).
- Reactive lists re-render: resolve and act in one call.
- `chrome://` tabs work, but their target id can change after load — select by URL.
- `screenshot` picks the format from the file extension (`.png` really is PNG) and
  reports an absolute path; a relative path is relative to **your** working
  directory. The content inside a `.png` name is never JPEG.
- `--frame` fails loudly when nothing matches. Same-origin frames can be read,
  clicked and filled; a cross-origin frame can be read but its position on the
  page cannot be measured, so acting there needs `cdp Input.dispatchMouseEvent`.
- `target="_blank"` links can be popup-blocked: read the `href`, then `open` it.
- Tab groups are not exposed by CDP; use `close --mine` and tab order.
- No command hangs forever. Each one gets a budget (20 s for cheap calls, 60 s for
  navigation/scroll, `wait` = its `--timeout` + 5 s); when it runs out the error
  names the command and what to check. `PALMIFER_CMD_BUDGET_MS` changes it, and an
  explicit `--timeout` on `wait` raises it to at least that long.
  A command stuck mid-flight is stopped with `palmifer cancel` — which keeps the
  daemon, so the Chrome approval is not lost.
- Chrome only feeds input to the tab it is showing: `scroll`/`click`/`fill`/`press`
  refuse a hidden tab instead of hanging 60 s. Run `palmifer front`, or pass
  `--front` so the command raises the tab itself. Long unattended runs need
  `--front`: the user will have wandered off to another tab long before it ends.
- Closing the last tab leaves Chrome with no window at all; `close` refuses that
  unless you pass `--force`.
- Modern sites hide content in nested web components. `dom`, `click --text`,
  `wait --text` and the accessibility snapshot see through open shadow roots; a
  hand-written `document.querySelector` does not.
- Detail pages opened as an **overlay** keep the feed alive behind the mask, so an
  unscoped `document.querySelector(".title")` happily returns a card the user
  cannot see. Scope the read: `dom ".title" --within ".note-detail-mask"`, or
  check `dom` for more matches than expected before trusting a value.
- Lists that reshuffle between loads (search results) cannot be clicked by a title
  captured earlier: click by position instead — `click "section.note-item" --nth 3`
  — and read the item's own page for its real title.
- Some sites render their search box collapsed, or as an icon with no label:
  `dom` reports it as `w:0,h:0` and `fill` refuses it (correctly). Use the site's
  own search URL with `goto` instead of fighting the hidden control.
- A throwaway browser (`browser`) closes itself after 30 minutes without a
  command; a `--profile-dir` one never does. `PALMIFER_PRIVATE_IDLE_MIN` changes
  the first. `browser status` and `status` keep working afterwards.

## Notes

- Every request carries the token the daemon writes to `~/.cache/palmifer/token` (0600) on first run; non-loopback hosts and untokened requests are rejected.
- Daemon on `127.0.0.1:8798` (override `PALMIFER_DAEMON_PORT`); state and logs
  in `~/.cache/palmifer/`. A command error never kills the daemon.
- Proxy environment variables are stripped at startup: the tool only talks to
  loopback, and `NODE_USE_ENV_PROXY=1` routes even `127.0.0.1` sockets through an
  outbound proxy, where the handshake hangs.
