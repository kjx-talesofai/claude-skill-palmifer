<p align="center">
  <img src="assets/palmifer.jpg" alt="palmifer — 泡米饭" height="150"/>
</p>

# palmifer

Let an AI agent drive **your** Chrome — the one you are already signed into — over CDP. One CLI, one small local daemon, no Node dependencies, no browser extension, no account.

> palmifer -- 泡米饭

<!-- 维护提醒：改动下面英文的安装步骤 / 注意事项时，请同步更新这个中文折叠块（两者事实必须一致）。 -->

<details>
<summary><b>中文说明（点开）</b> —— 用你已登录的 Chrome，让 agent 替你打开网页、点击、填表、截图</summary>

**它是什么**：一个本地命令行工具加一个常驻小 daemon，让 AI agent 通过 CDP 操作**你自己那个已登录的 Chrome**。没有浏览器扩展，没有账号，没有云。

**为什么做**：以前我一直用 kimi-webbridge，它第一次让 agent 能"以你的身份"在真浏览器里干活。后来它长成了一个更完整的产品（自带账号和侧边栏）——对产品来说是好事，只是不再是我要的那座中立的桥。有点可惜，毕竟以前天天用。所以 palmifer 就是把这件事做小：**只做桥**。

**开启调试**（每个 Chrome 会话都要做一次）：

1. 打开 `chrome://inspect/#remote-debugging`
2. 勾选 **"Allow remote debugging for this browser instance"**
3. Chrome 询问是否允许连接时，点 **Allow**

```bash
# 推荐：装为 agent 技能
npx skills add kjx-talesofai/claude-skill-palmifer -g -a cline
# 或者直接 clone
git clone https://github.com/kjx-talesofai/claude-skill-palmifer.git ~/.agents/skills/palmifer
export PATH="$HOME/.agents/skills/palmifer/bin:$PATH"
palmifer status
```

需要 Node ≥ 22（自带 fetch 与 WebSocket），不需要 npm install。

**常用命令**：`palmifer open <url>` 打开页面 · `palmifer snapshot` 给 agent 读的页面结构（带 `@eN` 引用）· `palmifer fill @e10 "关键词"` 填表 · `palmifer press Enter` 回车提交 · `palmifer click "button"` 点击 · `palmifer screenshot /tmp/a.png` 截图。完整清单见 [SKILL.md](SKILL.md)。

**两种浏览器**：默认操作**你自己的 Chrome**（带你所有登录态）。如果不想用你的浏览器、或者没人在旁边点 Allow（服务器、CI、无人值守），用 `palmifer browser` —— 它自己起一个全新的临时 profile 的 Chrome，**默认无头**，不用授权、没有任何你的数据；`palmifer browser close` 退出并删掉临时 profile。`palmifer anon on` 是在**当前浏览器里**开一个没有 cookie 的匿名上下文（Chrome 会为它单开一个窗口），任务跑完 `palmifer anon off` 关掉。三者区别：

| | 浏览器 | 需要点 Allow | 有你的登录态 | 窗口 |
|---|---|---|---|---|
| 默认 | 你的 Chrome | 要，每个 daemon 一次 | 有 | 你原来的窗口 |
| `palmifer browser` | palmifer 自己起的临时 Chrome | 不要 | 没有 | 无头（`--headed` 可开窗） |
| `palmifer anon on` | 当前浏览器里的匿名上下文 | 同上 | 没有 | 新开一个 |

匿名隔离是**测过的、不是口头保证**：`node tests/private-mode.test.mjs` 会在普通上下文里种一个 cookie、确认它重开还在，再确认匿名上下文读不到它，最后确认关掉匿名后 cookie 依然在。

**注意事项**：

- 那个开关**按浏览器实例**生效，Chrome 重启后要重新勾选。
- 开着开关时 Chrome 会显示「正受到自动测试软件的控制」横幅，属正常现象。
- daemon 只监听 `127.0.0.1`；每个请求都要带令牌，令牌在首次运行时写入 `~/.cache/palmifer/token`。
- 目前只在 macOS 上实测；Linux 的路径已写好，但没验证过。

卸载：`rm -rf ~/.agents/skills/palmifer ~/.cache/palmifer`

**授权**：Chrome 是**按连接方**逐次授权的 —— daemon 启动时连一次，所以是「每次 daemon 启动点一次 Allow」，之后的命令都不再弹窗。

**测速**：`palmifer bench` 只跑只读命令，把延迟拆成三层（进程启动 / daemon HTTP / 真实 CDP 往返），并单独测冷启动。

**默认行为**：按"人的节奏"操作——带缓动的鼠标轨迹、逐字输入、导航后停顿、动作之间留间隔，也不让连续操作过密。只读任务可以用 `--fast` 跳过等待。

</details>

```
agent ── bash ──▶ palmifer ── HTTP ──▶ daemon ── CDP ──▶ your Chrome
                    (CLI)             127.0.0.1          (your logins)
```

## Why

I used kimi-webbridge for a long time and liked it: it was the first bridge that let an agent act as *you*, inside the browser where your sessions actually live. It has since grown into a bigger product with its own account and side panel. That is a fine direction for a product. It just left the bridge no longer the neutral plumbing I needed it to be — a bit sad, since it had become part of the daily routine.

So palmifer is the small version of that idea: **a bridge that only bridges.** Your browser, your logins, nothing in between.

## How it works

Chrome 136+ refuses `--remote-debugging-port` on the default profile. Chrome 155 and later ship a per-instance opt-in instead: tick *"Allow remote debugging for this browser instance"* at `chrome://inspect/#remote-debugging`, and Chrome exposes a loopback CDP endpoint.

palmifer speaks CDP to that endpoint:

- **One file.** `bin/palmifer.mjs` is the whole CLI and daemon — Node >= 22, no dependency tree, no build step.
- **One connection.** Chrome asks for approval whenever a new client connects, so a long-lived daemon holds the single CDP session: you click *Allow* once per daemon start, not once per command.
- **Your browser by default, its own when yours is not there.** `palmifer browser` starts a throwaway Chrome in a temp profile — headless, no opt-in click, no logins — for servers, CI and unattended runs. `palmifer anon on` gives the browser already in use a cookie-less context instead.
- **Real input.** Clicks and typing go through the browser's own input pipeline, so pages that reject synthetic events behave normally.
- **Human-paced by default.** An eased pointer path, character-by-character typing, a pause after navigation, spacing between actions and a cap on action bursts. `--fast` opts out for read-only work.
- **Nothing to escape.** `cdp <Domain.method>` passes any raw CDP command through when the built-in commands are not enough.

## Install

Install it as a skill (any agent that reads `~/.agents/skills`):

```bash
npx skills add kjx-talesofai/claude-skill-palmifer -g -a cline
```

Or clone it by hand:

```bash
git clone https://github.com/kjx-talesofai/claude-skill-palmifer.git ~/.agents/skills/palmifer
export PATH="$HOME/.agents/skills/palmifer/bin:$PATH"
```

Then, once per Chrome session:

1. Open `chrome://inspect/#remote-debugging`
2. Tick **"Allow remote debugging for this browser instance"**
3. Click **Allow** when Chrome asks to approve the connection

```bash
$ palmifer status
{"ok":true,"mode":"real","endpoint":"ws://127.0.0.1:9222/devtools/browser/...","browser":"Chrome/155.0.8059.27","protocol":"1.3","tabs":3,"anonContext":null}
```

Requires Node >= 22 (built-in `fetch` and `WebSocket`). There is no npm install. Tested on macOS; Linux paths are included but not tried yet.

## Quick use

```bash
palmifer open "https://example.com"
palmifer snapshot                     # accessibility tree with @eN refs
palmifer fill @e10 "search terms"     # @eN comes from the snapshot above
palmifer press Enter                  # real key event: Enter, Tab, Escape, Meta+A
palmifer click "button[type=submit]"
palmifer screenshot /tmp/page.png
```

The daemon starts itself on the first command and listens on `127.0.0.1:8798`; stop it with `palmifer stop`.

`bin/palmifer` is a curl + jq shim for the common cases (~40 ms per call); `bin/palmifer.mjs` is the full CLI. Both accept every command — the shim needs `curl` and `jq`, the Node file needs nothing. The complete command and flag list lives in [SKILL.md](SKILL.md).

## Two browsers, three levels of privacy

| | which browser | approval click | your cookies | window |
|---|---|---|---|---|
| default | the one you are signed into | yes, once per daemon start | yes | the one you already have |
| `palmifer browser` | palmifer's own Chrome, fresh temp profile | no | none | none (headless; `--headed` shows one) |
| `palmifer anon on` | a cookie-less context in the current browser | as above | none | Chrome opens a new one |

`palmifer browser` is the unattended path: nothing to approve, nothing of the
user's on disk, and `palmifer browser close` kills the process and deletes the
profile. That is what you want on a server, in CI, or when nobody is around to
click *Allow*. `palmifer browser --headed` shows the window while keeping the
throwaway profile. `palmifer browser use real` switches back without stopping
it.

`palmifer anon on` keeps working in the browser that is already open — same
Chrome, same binary — but every tab opened from then on gets its own empty
cookie jar, so a task can run without touching the user's sessions. On a site
where they are logged in, the anonymous tab is logged out; `palmifer anon off`
closes those tabs and the normal profile is exactly as it was.

## Tests

```bash
node tests/private-mode.test.mjs      # 26 checks, needs Node >= 22 and Chrome
```

It uses its own daemon port and its own state directory, so it never touches the
palmifer you use day to day, and it only ever drives the throwaway browser — your
own Chrome is not contacted. Anonymity is checked with a real cookie: set it in
the normal context, confirm it survives reopening there, confirm the anonymous
context cannot see it, then confirm turning anonymity off brings it back.

## Benchmark

`palmifer bench` measures whole calls, not IPC latency. Numbers below: macOS arm64, Node 26.3, Chrome 155, a
generated fixture page (300 rows + a form) with every command pinned to that tab, 25 samples per cell after
3 discarded warm-up calls.

| command | shim p50 | cli p50 | http p50 | http p90 | sd (shim) |
|---|---|---|---|---|---|
| `status` | 43.3 ms | 129.8 ms | 1.9 ms | 2.1 ms | 1.2 |
| `tabs` | 43.8 ms | 131.6 ms | 1.4 ms | 1.8 ms | 5.0 |
| `eval 1+1` | 45.9 ms | 133.8 ms | 3.8 ms | 5.3 ms | 2.0 |
| `text` | 49.4 ms | 135.5 ms | 5.0 ms | 6.5 ms | 1.8 |
| `snapshot --actionable-only` | 101.0 ms | 187.4 ms | 50.6 ms | 53.2 ms | 5.2 |
| `snapshot` | 97.3 ms | 184.8 ms | 49.9 ms | 52.8 ms | 2.0 |
| `screenshot` | 95.0 ms | 184.7 ms | 41.9 ms | 55.7 ms | 4.7 |

Writes, measured in a separate run with the burst guard lifted (`PALMIFER_ACTION_CAP=10000`), because
otherwise the guard refuses them and you end up benchmarking the guard:

| action | `--fast` (n=10) | default, paced (n=5) |
|---|---|---|
| `fill` a 2-character value | 49.7 ms | 1.20 s |
| `click` a button | 50.5 ms | 1.18 s |

**Reading it.** `http` is the daemon's own round trip with no process spawn, so it is close to the raw CDP
call: 1.4–5 ms for cheap commands, ~50 ms for an accessibility snapshot. `shim − http` is curl + jq + one
process (~40 ms); `cli − shim` is Node's startup (~85 ms). **Process startup, not the browser, dominates
every call** — which is the only reason `bin/palmifer` exists. Paced writes are the design budget: one
spacing gap (≥1.2 s), per-character typing (45–140 ms) and an eased pointer path. `--fast` skips the waiting.

**Methodology**, so the numbers can be argued with:

- one child process per measured call, wall time from a monotonic clock
- `--warmup 3` calls per cell are discarded before sampling
- path order rotates each iteration, so drift (CPU ramp, page state) is shared instead of owned by one path
- failures are counted and printed with their reason, never dropped from the sample
- `--json` emits every raw sample, so the statistics can be recomputed
- `--full` generates the fixture, pins the tab per call, and closes it afterwards
- `--cold` is opt-in: it restarts the daemon, Chrome asks for approval again, and your click would land
  inside the measurement — the one number a benchmark cannot take for you

It does not measure network time, page load, or any other tool.

**Stability.** 1200 mixed calls (300 of them `snapshot`, the heaviest read path) in 58 s: **0 failures**.
With the daemon started under `--expose-gc`, `palmifer mem` reports memory after a forced collection:

| calls | rss | heapUsed | heapTotal |
|---|---|---|---|
| 0 | 60.7 MB | 7.0 MB | 8.9 MB |
| 400 | 75.1 MB | 8.4 MB | 17.4 MB |
| 800 | 84.0 MB | 8.4 MB | 23.6 MB |
| 1200 | 92.7 MB | 8.3 MB | 31.6 MB |

RSS climbs because V8 keeps reserving heap (`heapTotal` grows); the data actually in use stays near 8 MB and
stops growing. RSS is a high-water mark — check `mem` before calling something a leak.

```bash
palmifer bench --full --runs 25     # publishable run
palmifer bench --json > bench.json  # raw samples
palmifer bench                      # quick look at the current tab
palmifer bench --writes-only        # only the write paths (isolated)
```

## Notes

- The opt-in is **per browser instance** and resets when Chrome restarts.
- Chrome approves **per connecting client**, so it is one *Allow* per daemon start: after `palmifer stop`, or after the daemon exits, the next command asks again. Commands never ask.
- Loopback only: the daemon binds `127.0.0.1`, requires the token it writes on first run to `~/.cache/palmifer/token`, and rejects non-loopback hosts.
- While the toggle is on, Chrome shows a "being controlled by automated test software" banner.
- The throwaway browser's profile lives under the OS temp dir and is deleted by `palmifer browser close`; a profile left behind by a crash is cleaned up on the next start.
- Anonymous contexts live only as long as Chrome does, and only inside the browser that was current when they were created. Chrome restarting, or a `browser`/`browser use` switch, simply means running `anon on` again.
- Tab groups are not exposed by CDP; use `close --mine` and tab order.

Uninstall: `rm -rf ~/.agents/skills/palmifer ~/.cache/palmifer`

## Author

<p>
  <a href="https://hypersampling.com">
    <img src="https://assets.hypersampling.com/hyper-sampling-2.jpg" alt="hypersampling" height="38"/>
  </a>
</p>

Built by [Jiaxin Kou](https://hypersampling.com) · [GitHub](https://github.com/kjx-talesofai)

## License

MIT
