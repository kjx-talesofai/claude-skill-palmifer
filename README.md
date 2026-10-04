<p align="center">
  <img src="assets/palmifer.jpg" alt="palmifer — 泡米饭" height="150"/>
</p>

<p align="center">
  <img src="https://assets.hypersampling.com/hyper-sampling-2.jpg" alt="hypersampling" height="38"/>
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
git clone https://github.com/kjx-talesofai/claude-skill-palmifer.git ~/.agents/skills/palmifer
export PATH="$HOME/.agents/skills/palmifer/bin:$PATH"
palmifer status
```

需要 Node ≥ 22（自带 fetch 与 WebSocket），不需要 npm install。

**常用命令**：`palmifer open <url>` 打开页面 · `palmifer snapshot` 给 agent 读的页面结构（带 `@eN` 引用）· `palmifer fill @e10 "关键词"` 填表 · `palmifer click "button"` 点击 · `palmifer screenshot /tmp/a.png` 截图。完整清单见 [SKILL.md](SKILL.md)。

**注意事项**：

- 那个开关**按浏览器实例**生效，Chrome 重启后要重新勾选。
- 开着开关时 Chrome 会显示「正受到自动测试软件的控制」横幅，属正常现象。
- daemon 只监听 `127.0.0.1`；每个请求都要带令牌，令牌在首次运行时写入 `~/.cache/palmifer/token`。
- 目前只在 macOS 上实测；Linux 的路径已写好，但没验证过。

卸载：`rm -rf ~/.agents/skills/palmifer ~/.cache/palmifer`

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
- **One connection.** Chrome asks for approval whenever a new client connects, so a long-lived daemon holds the single CDP session: you click *Allow* once, not once per command.
- **Real input.** Clicks and typing go through the browser's own input pipeline, so pages that reject synthetic events behave normally.
- **Human-paced by default.** An eased pointer path, character-by-character typing, a pause after navigation, spacing between actions and a cap on action bursts. `--fast` opts out for read-only work.
- **Nothing to escape.** `cdp <Domain.method>` passes any raw CDP command through when the built-in commands are not enough.

## Install

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
{"ok":true,"endpoint":"ws://127.0.0.1:9222/devtools/browser/...","browser":"Chrome/155.0.8059.27","protocol":"1.3","tabs":3,"ok":true}
```

Requires Node >= 22 (built-in `fetch` and `WebSocket`). There is no npm install. Tested on macOS; Linux paths are included but not tried yet.

## Quick use

```bash
palmifer open "https://example.com"
palmifer snapshot                     # accessibility tree with @eN refs
palmifer fill @e10 "search terms"     # @eN comes from the snapshot above
palmifer click "button[type=submit]"
palmifer screenshot /tmp/page.png
```

The daemon starts itself on the first command and listens on `127.0.0.1:8798`; stop it with `palmifer stop`.

`bin/palmifer` is a curl + jq shim for the common cases (~40 ms per call); `bin/palmifer.mjs` is the full CLI. Both accept every command — the shim needs `curl` and `jq`, the Node file needs nothing. The complete command and flag list lives in [SKILL.md](SKILL.md).

## Notes

- The opt-in is **per browser instance** and resets when Chrome restarts.
- Loopback only: the daemon binds `127.0.0.1`, requires the token it writes on first run to `~/.cache/palmifer/token`, and rejects non-loopback hosts.
- While the toggle is on, Chrome shows a "being controlled by automated test software" banner.
- Tab groups are not exposed by CDP; use `close --mine` and tab order.

Uninstall: `rm -rf ~/.agents/skills/palmifer ~/.cache/palmifer`

## Author

Built by [Jiaxin Kou](https://hypersampling.com) · [GitHub](https://github.com/kjx-talesofai)

## License

MIT
