#!/usr/bin/env node
/**
 * palmifer — drive the user's REAL Chrome/Chromium over raw CDP.
 *
 * Zero dependencies: Node's built-in fetch, WebSocket and http (Node >= 22).
 *
 * Why a daemon: Chrome's per-instance opt-in
 *   chrome://inspect/#remote-debugging -> "Allow remote debugging for this browser instance"
 * opens a loopback CDP server, but Chrome asks for permission **per connecting
 * client**. A one-shot CLI process is a new client every call, so it prompts
 * every call. This tool keeps one long-lived local daemon holding the single
 * CDP connection: you click "Allow" once, then every command reuses it.
 *
 * Two ways to get a browser, chosen explicitly:
 *   (default)     the browser you already have open, with your logins. Chrome
 *                 needs a one-time per-instance opt-in (above).
 *   `browser`     a throwaway instance palmifer starts itself, in a brand new
 *                 profile under the OS temp dir, headless by default. No opt-in,
 *                 no login, nothing of yours in it. `browser close` deletes it.
 * `anon` adds a cookie-less context *inside* whichever browser is in use, in
 * its own window, so a task can run without touching any logged-in session.
 *
 * Commands (run `palmifer help`):
 *   status | tabs | frames | use <tab> | open <url> | goto <url>
 *   snapshot | text | click | fill | press <key> | eval | wait | upload
 *   front                                raise this tab (input only reaches a visible tab)
 *   scroll <down|up|bottom|top>          real wheel events ([--amount N] [--times N])
 *   dom <css> | dom --text <str>         structural probe; pierces shadow roots
 *                                        (--text keeps the innermost matches; --all for ancestors)
 *   click --text <str> [--nth N]         click a control by its label, no selector
 *   screenshot | pdf | network <start|stop|list|detail> | cdp <method> [json]
 *   anon <on|off|status>                 cookie-less context, no logins, no profile
 *   browser [url] [--headed]             start the throwaway browser (headless)
 *   browser --profile-dir <dir> [url]    keep the profile: log in once, stay logged
 *                                        in across restarts (this is the server mode)
 *   browser --dry-run                    print the Chrome command line, launch nothing
 *   browser status | browser close | browser use <real|private>
 *   close [tab] [--mine|--all] | stop
 *   bench [--runs N] [--full] [--writes-only] [--json]   measure real latency
 *   mem                                                    daemon memory (heap after GC)
 *
 * Global flags:
 *   --tab <n|id|substr>      target tab (default: current)
 *   --frame <#fN|id|substr>  operate inside an iframe (see `frames`)
 *   --actionable-only        snapshot: only clickable/fillable nodes
 *   --filter <regex>         snapshot: only names matching regex
 *   --limit <n>              snapshot: node cap (default 220)
 *   --no-wait                open/goto: return without waiting for load
 *   --timeout <ms>           wait: give up after this (default 15000)
 *   --full                   screenshot: full page
 *   --fast                   skip the human pacing (see the pacing section)
 *   --text <str>             wait/click/dom: match by visible text (pierces shadow roots)
 *   --js <expr>              wait: poll an expression until it is truthy
 *   --amount <px> --times N  scroll: how far, how often (bottom/top repeat until it stops)
 *   --nth <n>                click --text: which match to use (default 1)
 *   --exact                  text matching must be the whole label
 *   --within <css>           dom/click --text: only look inside this container
 *   --allow-network          eval: silence the "this talks to the network" warning
 *   --front                  scroll/click/fill/press: raise the tab if it is hidden
 *   --headed                 browser: visible window instead of headless
 *   --profile-dir <dir>      browser: keep the profile here (logins survive)
 *   --dry-run                browser: print the command line, launch nothing
 *   --chrome <path>          browser: which Chrome/Chromium binary to launch
 *   --browser                cdp: send at browser level instead of the tab
 *   --port <cdpPort>         override the discovered CDP port
 *
 * Environment:
 *   PALMIFER_CHROME          Chrome/Chromium binary to launch
 *   PALMIFER_CHROME_FLAGS    extra Chrome flags, e.g. "--lang=zh-CN --window-size=1280,900"
 *   PALMIFER_PROFILE_DIR     same as --profile-dir
 *   PALMIFER_FAST=1          disable human pacing
 *   PALMIFER_ACTION_CAP      burst cap per 10 min (default 80)
 *   PALMIFER_DAEMON_PORT     default 8798
 *   PALMIFER_STATE_DIR       default ~/.cache/palmifer
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  openSync,
  rmSync,
  mkdtempSync,
  statfsSync,
  statSync,
} from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, dirname, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromeLaunchFlags, shmSizeMb, sandboxUnavailable } from "./launch-flags.mjs";
import { spawn } from "node:child_process";
import http from "node:http";

// Only ever talk to 127.0.0.1. Agent runtimes export HTTP(S)_PROXY / ALL_PROXY /
// NODE_USE_ENV_PROXY for outbound traffic; Node 22+ then routes even loopback
// WebSockets through that proxy, where the connection hangs silently (no error
// event, readyState stuck at CONNECTING). Strip them before the first socket,
// and give Node a no_proxy value it can parse — runtimes inject `[::1]`, whose
// brackets break its matcher.
for (const k of [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY",
  "http_proxy", "https_proxy", "all_proxy",
]) delete process.env[k];
process.env.NO_PROXY = "localhost,127.0.0.1,::1";
process.env.no_proxy = "localhost,127.0.0.1,::1";

const SELF = fileURLToPath(import.meta.url);
const STATE_DIR = process.env.PALMIFER_STATE_DIR || join(homedir(), ".cache", "palmifer");
const STATE_FILE = join(STATE_DIR, "state.json");
const PID_FILE = join(STATE_DIR, "daemon.pid");
const LOG_FILE = join(STATE_DIR, "daemon.log");
const BUILD_FILE = join(STATE_DIR, "daemon.build.json");
const DAEMON_PORT = Number(process.env.PALMIFER_DAEMON_PORT || 8798);
// The hint has to match the mode: telling someone to click Allow in
// chrome://inspect is useless when the browser at fault is our own headless one.
function inspectHint() {
  if (activeMode() === "private") {
    return (
      "the throwaway browser is not answering any more.\n" +
      "Start it again with `palmifer browser`, or go back to your own browser with\n" +
      "`palmifer browser use real`."
    );
  }
  return REAL_HINT;
}

// The daemon drives a browser holding the user's sessions, so every request
// carries a per-install token (0600) and the server refuses non-loopback hosts.
const TOKEN_FILE = join(STATE_DIR, "token");
function daemonToken() {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}
function ensureToken() {
  const existing = daemonToken();
  if (existing) return existing;
  mkdirSync(STATE_DIR, { recursive: true });
  const token = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const args = {};
const positional = [];
const VALUED = new Set([
  "tab",
  "frame",
  "limit",
  "max",
  "port",
  "session",
  "filter",
  "timeout",
  "seconds",
  "chrome",
  "profile-dir",
  "text", // wait --text / click --text / dom --text take a value, not a bare flag
  "selector",
  "amount",
  "times",
  "nth",
  "js",
  "within",
]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const name = a.slice(2);
    if (VALUED.has(name)) args[name] = argv[++i];
    else args[name] = true;
  } else positional.push(a);
}
const cmd = positional[0];
const rest = positional.slice(1);

function out(v) {
  console.log(typeof v === "string" ? v : JSON.stringify(v));
}
// Inside the daemon a command error must unwind as an exception, never exit the
// process — otherwise one bad selector takes the whole service down.
let inDaemon = false;
function fail(msg, code = 1) {
  if (inDaemon) throw new Error(msg);
  console.error(msg);
  process.exit(code);
}
function printHelp() {
  const doc = readFileSync(SELF, "utf8");
  console.log(doc.split("/**")[1].split("*/")[0].replace(/^ \* ?/gm, "").trim());
}

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  printHelp();
  process.exit(0);
}

// ------------------------------------------------- which browser
//
// Two browsers are reachable: the one the user already runs (default, their
// logins) and a throwaway instance palmifer starts itself (`palmifer browser`).
// mode.json records which one the daemon should talk to, so the choice survives
// daemon restarts instead of being an environment variable nobody remembers.

const PRIVATE_FILE = join(STATE_DIR, "private.json");
const MODE_FILE = join(STATE_DIR, "mode.json");

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function writeJson(file, value) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** The throwaway browser we started — but only while its process is alive. */
function privateBrowser() {
  const p = readJson(PRIVATE_FILE);
  return p && p.pid && p.endpoint && pidAlive(p.pid) ? p : null;
}
const activeMode = () => ((readJson(MODE_FILE) || {}).mode === "private" ? "private" : "real");
const setMode = (mode) => writeJson(MODE_FILE, { mode });

/**
 * Tabs and @e refs belong to one browser; carrying them across a switch would
 * aim the next command at a tab that does not exist there. The anonymous
 * context id is kept on purpose: contexts are per-browser, so if the user
 * switches away and back, `anonContext()` still finds it (and `anon off` can
 * still close it) instead of leaving an orphan window behind.
 */
function forgetTabs() {
  state.current = null;
  state.refs = {};
  state.refsTab = null;
  saveState(state);
}

const REAL_HINT =
  "Chrome remote debugging is not enabled (or was switched off).\n" +
  "Open this in the browser you want to control and tick the box:\n" +
  '  chrome://inspect/#remote-debugging -> "Allow remote debugging for this browser instance"\n' +
  "Chrome will ask you to approve the connecting app once — click Allow.\n" +
  "No browser to approve, or running unattended? `palmifer browser` starts a\n" +
  "throwaway headless one that needs no opt-in.";

function browserBinary() {
  if (args.chrome) return String(args.chrome);
  if (process.env.PALMIFER_CHROME) return process.env.PALMIFER_CHROME;
  const mac = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  const win = [
    join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
    join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
  ];
  const onPath = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "brave-browser",
  ];
  for (const p of mac) if (existsSync(p)) return p;
  for (const p of win) if (p && existsSync(p)) return p;
  for (const name of onPath) {
    for (const dir of String(process.env.PATH || "").split(delimiter)) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return null;
}

// ---------------------------------------------------------------- discovery

function discoveryCandidates() {
  const home = homedir();
  if (process.platform === "darwin") {
    return [
      join(home, "Library/Application Support/Google/Chrome/DevToolsActivePort"),
      join(home, "Library/Application Support/Chromium/DevToolsActivePort"),
      join(home, "Library/Application Support/Microsoft Edge/DevToolsActivePort"),
    ];
  }
  if (process.platform === "linux") {
    return [
      join(home, ".config/google-chrome/DevToolsActivePort"),
      join(home, ".config/chromium/DevToolsActivePort"),
    ];
  }
  return [join(process.env.LOCALAPPDATA || "", "Google/Chrome/User Data/DevToolsActivePort")];
}

/** The user's own browser, found through the DevToolsActivePort it writes. */
function realEndpoint() {
  for (const f of discoveryCandidates()) {
    if (!existsSync(f)) continue;
    const [port, path] = readFileSync(f, "utf8").trim().split("\n");
    if (port && path) return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
  }
  return null;
}

function resolveEndpoint() {
  if (process.env.PALMIFER_ENDPOINT) return process.env.PALMIFER_ENDPOINT;
  if (args.port) {
    // A bare port is useless on its own: the endpoint needs its browser path.
    for (const f of discoveryCandidates()) {
      if (!existsSync(f)) continue;
      const [, path] = readFileSync(f, "utf8").trim().split("\n");
      if (path) return `ws://127.0.0.1:${args.port}${path.trim()}`;
    }
    return `ws://127.0.0.1:${args.port}`;
  }
  if (activeMode() === "private") {
    const priv = privateBrowser();
    if (priv) return priv.endpoint;
    setMode("real"); // it is gone; fall back instead of failing confusingly
  }
  return realEndpoint();
}

/**
 * Identity of the code the daemon loaded. A long-lived daemon happily keeps
 * running yesterday's file, so editing the CLI would look like "my change did
 * nothing" — this is what lets the client say so out loud.
 */
function buildFingerprint() {
  // Content, not mtime: copying the file (or touching it) is not a code change,
  // and a warning that cries wolf is worse than no warning.
  try {
    const hash = (f) => createHash("sha1").update(readFileSync(f)).digest("hex").slice(0, 12);
    const flags = join(dirname(SELF), "launch-flags.mjs");
    return hash(SELF) + (existsSync(flags) ? "+" + hash(flags) : "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- state

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!Array.isArray(s.opened)) s.opened = [];
    if (!s.anonContexts || typeof s.anonContexts !== "object") s.anonContexts = {};
    return s;
  } catch {
    return { current: null, refs: {}, opened: [], anonContexts: {} };
  }
}
function saveState(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s));
}
const state = loadState();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- human pacing
//
// Default behaviour is to act like a considerate human, because a tool that
// drives a real logged-in browser should behave the way that browser's owner
// does: read before acting, move the pointer, type at human speed, and never
// fire actions in a burst. These defaults live in the code, not only in the
// docs, so an agent that forgets to read the skill is still paced.
//
// `--fast` (or PALMIFER_FAST=1) turns the pacing off: appropriate for
// read-only commands (snapshot/eval/screenshot) or when the user asks for speed.

const HUMAN_DEFAULT = process.env.PALMIFER_FAST !== "1";
// Per request, not per daemon: --fast must apply to the command that carries it
// and to nothing else. (`args` is rebound for every request.)
const isHuman = () => HUMAN_DEFAULT && !args.fast;
const minWriteGapMs = () => Number(process.env.PALMIFER_MIN_GAP_MS || (isHuman() ? 1200 : 0));
const ACTION_CAP_PER_10MIN = Number(process.env.PALMIFER_ACTION_CAP || 80);
const rand = (min, max) => min + Math.random() * (max - min);

async function dwell(min = 900, max = 2200) {
  if (isHuman()) await sleep(rand(min, max));
}

/** Mention a host once per daemon run, the first time a command touches it. */
const seenHosts = new Set();
function noteHost(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (!host || seenHosts.has(host)) return;
  seenHosts.add(host);
  console.log(
    `· new host ${host}: human-paced defaults on (pointer path, human typing, read-before-act). ` +
      `Say "faster" / --fast to skip waiting.`,
  );
}

/** Space out UI actions and cap bursts, so a loop cannot hammer a site. */
function paceAction() {
  state.actions = (state.actions || []).filter((t) => Date.now() - t < 10 * 60 * 1000);
  if (state.actions.length >= ACTION_CAP_PER_10MIN) {
    fail(
      `action cap reached (${ACTION_CAP_PER_10MIN} in 10 min) — the built-in guard that keeps an ` +
        `automated loop from hammering a site. Stop and check with the user before continuing.`,
    );
  }
  const last = state.actions[state.actions.length - 1] || 0;
  const wait = Math.max(0, minWriteGapMs() - (Date.now() - last));
  state.actions.push(Date.now() + wait);
  saveState(state);
  if (wait > 0) return sleep(wait);
  return Promise.resolve();
}

/** Move the pointer along an eased path instead of teleporting to the target. */
async function movePointer(cdp, sessionId, x, y) {
  if (!isHuman()) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
    return;
  }
  const steps = 8 + Math.floor(Math.random() * 8);
  const sx = x + rand(-200, 200);
  const sy = y + rand(-140, 140);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: sx + (x - sx) * e + rand(-1.5, 1.5), y: sy + (y - sy) * e + rand(-1.5, 1.5) },
      sessionId,
    );
    await sleep(rand(8, 26));
  }
}

/** Type text the way a person does: character by character, with jitter. */
async function typeText(cdp, sessionId, text) {
  if (!isHuman()) {
    await cdp.send("Input.insertText", { text }, sessionId);
    return;
  }
  for (const ch of text) {
    await cdp.send("Input.insertText", { text: ch }, sessionId);
    await sleep(rand(45, 140));
  }
}

/** The default click: real input events, human pointer path, paced. */
async function trustedClick(cdp, sessionId, sel) {
  return trustedClickAt(cdp, sessionId, await elementRect(cdp, sessionId, sel));
}

/**
 * Chrome only feeds input events to the tab it is actually showing; a hidden
 * tab swallows them and the CDP call sits there until it times out. Fail with
 * something actionable instead of a 60-second silence.
 */
async function ensureVisible(cdp, sessionId) {
  let vs = await evaluate(cdp, sessionId, "document.visibilityState").catch(() => "visible");
  if (vs !== "hidden") return;
  // --front is the caller saying "yes, raise it": unattended runs need this
  // (a long collection drives whatever window the user has wandered off to),
  // but stealing focus silently is not something a tool should decide alone.
  if (args.front) {
    await cdp.send("Page.bringToFront", {}, sessionId).catch(() => {});
    await sleep(250);
    vs = await evaluate(cdp, sessionId, "document.visibilityState").catch(() => "visible");
    if (vs !== "hidden") return;
  }
  fail(
    "this tab is in the background, so real input events would queue forever.\n" +
      "  Pass --front to raise it, run `palmifer front`, or pick a visible tab with --tab.",
  );
}

/** Real mouse press/release at a point, with the human pointer path. */
async function trustedClickAt(cdp, sessionId, rect) {
  await ensureVisible(cdp, sessionId);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {});
  await movePointer(cdp, sessionId, rect.x, rect.y);
  if (isHuman()) await sleep(rand(30, 110));
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 },
    sessionId,
  );
  await sleep(isHuman() ? rand(45, 130) : 10);
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 },
    sessionId,
  );
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false }, sessionId).catch(() => {});
  return rect;
}

// ---------------------------------------------------------------- cdp client

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id);
        clearTimeout(timer);
        this.pending.delete(m.id);
        m.error ? reject(new Error(`${m.error.message} (${m.error.code})`)) : resolve(m.result);
        return;
      }
      if (m.method) {
        for (const cb of this.listeners.get(m.method) || []) cb(m.params, m.sessionId);
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
    });
  }
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
    return () => {
      const list = this.listeners.get(method) || [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }
  send(method, params = {}, sessionId) {
    // A closed socket discards writes silently; say so instead of hanging.
    if (this.closed) return Promise.reject(new Error(inspectHint()));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

let conn = null;
let connUrl = null;

/** Can we actually open a WebSocket to this endpoint right now? */
async function canConnect(url, timeoutMs = 1500) {
  return new Promise((res) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      res(ok);
    };
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => finish(true), { once: true });
    ws.addEventListener("error", () => finish(false), { once: true });
    setTimeout(() => finish(false), timeoutMs);
  });
}

/** Drop the live connection so the next command re-resolves the endpoint. */
function resetConn() {
  if (conn) {
    try {
      conn.ws.close();
    } catch {}
  }
  conn = null;
  connUrl = null;
}

async function getConn() {
  const url = resolveEndpoint();
  // Keyed by URL, not merely "is there a connection": switching between the
  // user's browser and the throwaway one must not silently keep the old socket.
  if (conn && !conn.closed && connUrl === url) return conn;
  if (conn && !conn.closed && connUrl !== url) resetConn();
  if (!url) fail(inspectHint(), 2);
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error(`cannot reach the browser at ${url}\n${inspectHint()}`)), {
      once: true,
    });
    const t = setTimeout(() => rej(new Error(inspectHint())), 120000);
    ws.addEventListener("open", () => clearTimeout(t), { once: true });
  });
  conn = new Cdp(ws);
  connUrl = url;
  return conn;
}

/**
 * The anonymous context in force for the *current* browser, if it still exists.
 * Keyed per browser on purpose: a context created in the user's Chrome has no
 * meaning in the throwaway one, and forgetting it on a switch would leave an
 * orphan window nobody can close. Chrome also forgets contexts when it
 * restarts, so a stale id is dropped rather than reused.
 */
async function anonContext(cdp) {
  const map = (state.anonContexts = state.anonContexts || {});
  const mode = activeMode();
  const id = map[mode];
  if (!id) return null;
  try {
    const { browserContextIds } = await cdp.send("Target.getBrowserContexts");
    if ((browserContextIds || []).includes(id)) return id;
  } catch {}
  delete map[mode];
  saveState(state);
  return null;
}

async function pageTargets(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  return targetInfos.filter((t) => t.type === "page");
}

/** Forget tabs we opened that no longer exist — a user can close them at any time. */
function pruneOpened(pages) {
  const before = state.opened.length;
  state.opened = state.opened.filter((id) => pages.some((p) => p.targetId === id));
  if (state.opened.length !== before) saveState(state);
  return state.opened;
}

async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  for (const m of ["Runtime.enable", "Page.enable", "DOM.enable"]) {
    await cdp.send(m, {}, sessionId).catch(() => {});
  }
  return sessionId;
}

async function resolveTabInner(cdp) {
  const pages = await pageTargets(cdp);
  if (!pages.length) fail("no open tabs");
  const want = args.tab || state.current;
  if (!want) return pages[0];
  const byId = pages.find((t) => t.targetId === want);
  if (byId) return byId;
  // A bare number is the index printed by `tabs`, not a URL substring.
  if (/^\d+$/.test(String(want))) {
    const idx = Number(want);
    if (pages[idx]) return pages[idx];
  }
  const byUrl = pages.find((t) => t.url.includes(want) || t.title.includes(want));
  if (byUrl) return byUrl;
  fail(`no tab matching "${want}"`);
}

async function resolveTab(cdp) {
  const target = await resolveTabInner(cdp);
  noteHost(target.url);
  return target;
}

async function withTab(fn, { keepSession = false } = {}) {
  const cdp = await getConn();
  const target = await resolveTab(cdp);
  const sessionId = await attach(cdp, target.targetId);
  try {
    return await fn(cdp, sessionId, target);
  } finally {
    if (!keepSession) await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}

async function reattach(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  for (const m of ["Runtime.enable", "Page.enable", "DOM.enable"]) {
    await cdp.send(m, {}, sessionId).catch(() => {});
  }
  return sessionId;
}

async function evaluate(cdp, sessionId, expression, contextId) {
  const res = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) },
    sessionId,
  );
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result?.value;
}

async function waitReady(cdp, sessionId, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const rs = await evaluate(cdp, sessionId, "document.readyState").catch(() => "loading");
    if (rs === "complete" || rs === "interactive") return true;
    await sleep(250);
  }
  return false;
}

// ---------------------------------------------------------------- frames

async function listFrames(cdp, sessionId) {
  const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId);
  const flat = [];
  const walk = (n, depth) => {
    flat.push({ index: flat.length, id: n.frame.id, url: n.frame.url, name: n.frame.name || "", depth });
    for (const c of n.childFrames || []) walk(c, depth + 1);
  };
  walk(frameTree, 0);
  return flat;
}

async function resolveFrame(cdp, sessionId) {
  if (!args.frame) return null;
  const frames = await listFrames(cdp, sessionId);
  const want = String(args.frame);
  let found = null;
  if (want === "any") found = frames.find((f) => f.depth > 0) || null;
  else if (want.startsWith("#f")) found = frames[Number(want.slice(2))] || null;
  else found = frames.find((f) => f.id === want) || frames.find((f) => f.url.includes(want)) || null;
  // Never silently act on the top document when a frame was requested.
  if (!found) fail(`no frame matching "${want}" — run \`frames\` to list them`);
  return found;
}

/** Execution context of a frame, needed to evaluate inside it. */
async function frameContext(cdp, sessionId, frameId) {
  const seen = [];
  const off = cdp.on("Runtime.executionContextCreated", (p, sid) => {
    if (sid === sessionId) seen.push(p.context);
  });
  await cdp.send("Runtime.enable", {}, sessionId).catch(() => {});
  for (let i = 0; i < 8 && !seen.some((c) => c.auxData?.frameId === frameId); i++) {
    await sleep(150);
    await cdp.send("Runtime.enable", {}, sessionId).catch(() => {});
  }
  off();
  const forFrame = seen.filter((c) => c.auxData && c.auxData.frameId === frameId);
  const ctx = forFrame.find((c) => c.auxData.isDefault) || forFrame[0];
  if (ctx) return { contextId: ctx.id, isolated: false };
  // Last resort: an isolated world always exists for a frame, but page globals
  // (window.__INITIAL_STATE__ etc.) are NOT visible from it.
  try {
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId }, sessionId);
    return { contextId: executionContextId, isolated: true };
  } catch {
    return null;
  }
}

/** Centre of an element in viewport coordinates (for trusted input). */
async function elementRect(cdp, sessionId, sel) {
  if (!sel.startsWith("@e")) {
    // Resolve and measure in ONE call: SPA lists re-render between two calls and
    // a marker attribute would be wiped before the second round trip.
    const res = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height})})()`,
        returnByValue: true,
      },
      sessionId,
    );
    if (res.exceptionDetails) {
      fail(`selector threw: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    if (!res.result.value) fail(`selector not found: ${sel}`);
    const rect = JSON.parse(res.result.value);
    // A zero-size box means we matched a hidden helper element; clicking (0,0)
    // would silently hit whatever sits in the corner.
    if (rect.w < 2 || rect.h < 2) {
      fail(`selector matched a zero-size element (${rect.w}x${rect.h}): ${sel} — target a visible one`);
    }
    return rect;
  }
  const backendNodeId = state.refs[sel];
  if (!backendNodeId) fail(`unknown ref ${sel} — run snapshot first`);
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId }, sessionId);
  const { result } = await cdp.send(
    "Runtime.callFunctionOn",
    {
      objectId: object.objectId,
      functionDeclaration:
        "function(){this.scrollIntoView({block:'center'});const r=this.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})}",
      returnByValue: true,
    },
    sessionId,
  );
  return JSON.parse(result.value);
}

// ---------------------------------------------------------------- network capture (daemon memory)

let net = null; // { sessionId, targetId, requests: Map }

function netEnsureHandler(cdp) {
  cdp.on("Network.requestWillBeSent", (p, sid) => {
    if (!net || sid !== net.sessionId) return;
    if (net.requests.size > 2000) net.requests.delete(net.requests.keys().next().value);
    net.requests.set(p.requestId, {
      requestId: p.requestId,
      method: p.request.method,
      url: p.request.url,
      type: p.type,
      status: null,
      mimeType: null,
      completed: false,
      requestHeaders: p.request.headers,
      startedAt: Date.now(),
    });
  });
  cdp.on("Network.responseReceived", (p, sid) => {
    if (!net || sid !== net.sessionId) return;
    const r = net.requests.get(p.requestId);
    if (r) {
      r.status = p.response.status;
      r.mimeType = p.response.mimeType;
      r.responseHeaders = p.response.headers;
    }
  });
  cdp.on("Network.loadingFinished", (p, sid) => {
    if (!net || sid !== net.sessionId) return;
    const r = net.requests.get(p.requestId);
    if (r) r.completed = true;
  });
}

// ---------------------------------------------------------------- commands

const ACTIONABLE = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "listbox", "option", "menuitem", "tab", "switch", "slider", "spinbutton",
]);


// ---------------------------------------------------------------- deep lookups
//
// Modern sites render their content inside nested web components, so a plain
// document.querySelector sees an empty shell. Everything below walks open
// shadow roots too, because "read the page" has to mean the page the user sees.

const DEEP_JS = `
 function __palmScope(sel){ for(const r of __palmAll()){ try{ const el=(r.body||r).querySelector(sel); if(el) return el }catch(e){} } return null }
 function __palmAll(){ const roots=[document]; const seen=new Set(roots);
   for(let i=0;i<roots.length;i++){ let els; try{els=roots[i].querySelectorAll("*")}catch(e){continue}
     for(const el of els){ if(el.shadowRoot&&!seen.has(el.shadowRoot)){ seen.add(el.shadowRoot); roots.push(el.shadowRoot) } } }
   return roots }
 function __palmRoots(scope){ const roots=[scope||document]; const seen=new Set(roots);
   for(let i=0;i<roots.length;i++){ let els; try{els=roots[i].querySelectorAll("*")}catch(e){continue}
     for(const el of els){ if(el.shadowRoot&&!seen.has(el.shadowRoot)){ seen.add(el.shadowRoot); roots.push(el.shadowRoot) } } }
   return roots }
 function __palmText(el){ return ((el.innerText||el.textContent||"")+"").replace(/\\s+/g," ").trim() }
 function __palmInteractive(el){ const t=el.tagName?el.tagName.toLowerCase():"";
   return !!(t==="button"||t==="a"||t==="input"||t==="label"||t==="option"||t==="select"||el.getAttribute("role")==="button"
     || (el.onclick!==undefined&&el.onclick!==null) || (function(){try{return getComputedStyle(el).cursor==="pointer"}catch(e){return false}})()) }
 function __palmMatch(want,exact,scope){ const hits=[];
   for(const root of __palmRoots(scope)){ let els; try{els=root.querySelectorAll("*")}catch(e){continue}
     for(const el of els){ const own=__palmText(el); if(!own)continue;
       if(exact?own===want:own.includes(want)){ const r=el.getBoundingClientRect();
         hits.push({el,tag:el.tagName?el.tagName.toLowerCase():"",cls:(typeof el.className==="string"?el.className:"").slice(0,60),
           text:own.slice(0,90),x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,interactive:__palmInteractive(el)}) } } }
   return hits }
 function __palmDeepest(hits){ return hits.filter(h=>!hits.some(o=>o!==h&&h.el.contains(o.el))) }
 function __palmRank(hits){ const vis=hits.filter(h=>h.w>=2&&h.h>=2);
   // the innermost clickable thing wins: prefer real controls, then the smallest box
   return vis.sort((a,b)=>(b.interactive-a.interactive)||(a.w*a.h-b.w*b.h)) }
 function __palmPick(want,exact,nth,scope){ const ranked=__palmRank(__palmMatch(want,exact,scope));
   const pick=ranked[nth-1]; if(!pick) return null;
   pick.el.scrollIntoView({block:"center",inline:"center"});
   const r=pick.el.getBoundingClientRect();
   return {tag:pick.tag,cls:pick.cls,text:pick.text,interactive:pick.interactive,candidates:ranked.length,
     x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height} }
`;

/** Click target found by its visible text, through shadow roots. */
async function elementRectByText(cdp, sessionId, want, { nth = 1, exact = false, within = null } = {}) {
  const expr = `(()=>{${DEEP_JS}
    const scope=${within ? `__palmScope(${JSON.stringify(String(within))})` : "null"};
    if(${within ? "true" : "false"} && !scope) return JSON.stringify({error:"--within matched nothing"});
    const p=__palmPick(${JSON.stringify(String(want))},${exact ? "true" : "false"},${Number(nth) || 1},scope);
    if(!p) return null;
    return JSON.stringify(p)})()`;
  const raw = await evaluate(cdp, sessionId, expr);
  if (!raw) {
    fail(
      `no visible element with text ${exact ? "exactly " : ""}"${want}" — ` +
        `\`palmifer dom --text "${want}"\` lists what did match (shadow roots included)`,
    );
  }
  const rect = JSON.parse(raw);
  if (rect.error) fail(`${rect.error} — check the container selector with \`palmifer dom <sel>\``);
  if (rect.w < 2 || rect.h < 2) fail(`text "${want}" matched a zero-size element: ${rect.tag}.${rect.cls}`);
  return rect;
}

/** Elements matching a CSS selector or text, shadow roots included. */
async function deepQuery(cdp, sessionId, { selector = null, text = null, exact = false, limit = 20, within = null, all = false }) {
  const expr = `(()=>{${DEEP_JS}
    const rows=[];
    const scope=${within ? `__palmScope(${JSON.stringify(String(within))})` : "null"};
    if(${within ? "true" : "false"} && !scope) return JSON.stringify([{error:"--within matched nothing: "+${JSON.stringify(String(within || ""))}}]);
    if(${selector ? "true" : "false"}){
      for(const root of __palmRoots(scope)){ let els; try{els=root.querySelectorAll(${JSON.stringify(selector || "")})}catch(e){return JSON.stringify([{error:String(e.message||e)}])}
        for(const el of els){ const r=el.getBoundingClientRect();
          rows.push({tag:el.tagName?el.tagName.toLowerCase():"",cls:(typeof el.className==="string"?el.className:"").slice(0,50),
            text:__palmText(el).slice(0,90),interactive:__palmInteractive(el),shadow:root!==document,
            x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)}) } }
    } else {
      let hits=__palmMatch(${JSON.stringify(String(text || ""))},${exact ? "true" : "false"},scope);
      if(${all ? "false" : "true"}) hits=__palmDeepest(hits);
      for(const h of __palmRank(hits)){
        rows.push({tag:h.tag,cls:h.cls,text:h.text,interactive:h.interactive,shadow:!!h.el.getRootNode().host,
          x:Math.round(h.x),y:Math.round(h.y),w:Math.round(h.w),h:Math.round(h.h)}) } }
    return JSON.stringify(rows.slice(0,${Number(limit) || 20}))})()`;
  const raw = await evaluate(cdp, sessionId, expr);
  return JSON.parse(raw || "[]");
}

// ---------------------------------------------------------------- keyboard
//
// `fill` sets a value; forms still need Enter, Tab or Escape. Keys go through
// Input.dispatchKeyEvent so pages see trusted events, the same reason click
// uses the real mouse path.

const KEYS = {
  Enter: { vk: 13, code: "Enter", text: "\r" },
  Tab: { vk: 9, code: "Tab", text: "\t" },
  Escape: { vk: 27, code: "Escape" },
  Esc: { vk: 27, code: "Escape" },
  Backspace: { vk: 8, code: "Backspace" },
  Delete: { vk: 46, code: "Delete" },
  Space: { vk: 32, code: "Space", text: " " },
  ArrowUp: { vk: 38, code: "ArrowUp" },
  ArrowDown: { vk: 40, code: "ArrowDown" },
  ArrowLeft: { vk: 37, code: "ArrowLeft" },
  ArrowRight: { vk: 39, code: "ArrowRight" },
  Home: { vk: 36, code: "Home" },
  End: { vk: 35, code: "End" },
  PageUp: { vk: 33, code: "PageUp" },
  PageDown: { vk: 34, code: "PageDown" },
};

// CDP modifier bits: Alt 1, Control 2, Meta 4, Shift 8.
function keySpec(spec) {
  const parts = String(spec).split("+");
  const base = parts.pop();
  const has = (...names) => names.some((n) => parts.includes(n));
  const modifiers =
    (has("Alt", "Option") ? 1 : 0) |
    (has("Control", "Ctrl") ? 2 : 0) |
    (has("Meta", "Cmd", "Command") ? 4 : 0) |
    (has("Shift") ? 8 : 0);
  let key = KEYS[base];
  if (!key && /^[a-zA-Z0-9]$/.test(base)) {
    key = {
      vk: base.toUpperCase().charCodeAt(0),
      code: /[a-zA-Z]/.test(base) ? `Key${base.toUpperCase()}` : `Digit${base}`,
      text: base,
    };
  }
  if (!key) fail(`unknown key "${spec}" — try Enter, Tab, Escape, ArrowDown, Meta+A`);
  let text = key.text;
  if (modifiers & (1 | 2 | 4)) text = undefined; // Ctrl+A selects, it must not type "a"
  else if (text && modifiers & 8) text = text.toUpperCase();
  const out = {
    key: base === "Space" ? " " : base,
    code: key.code,
    windowsVirtualKeyCode: key.vk,
    nativeVirtualKeyCode: key.vk,
    modifiers,
  };
  if (text !== undefined) {
    out.text = text;
    out.unmodifiedText = key.text;
  }
  return out;
}

const commands = {
  async status() {
    const cdp = await getConn();
    const v = await cdp.send("Browser.getVersion");
    const pages = await pageTargets(cdp);
    const anon = await anonContext(cdp);
    out({
      ok: true,
      mode: activeMode(),
      endpoint: resolveEndpoint(),
      browser: v.product,
      protocol: v.protocolVersion,
      tabs: pages.length,
      anonContext: anon,
      current: state.current,
      openedByMe: pruneOpened(pages).length,
      networkCapturing: !!net,
      daemon: true,
    });
  },

  async tabs() {
    const cdp = await getConn();
    const pages = await pageTargets(cdp);
    const mine = pruneOpened(pages);
    const anon = await anonContext(cdp);
    out(
      pages.map((t, i) => ({
        i,
        id: t.targetId,
        current: t.targetId === state.current,
        mine: mine.includes(t.targetId),
        anon: !!anon && t.browserContextId === anon,
        title: t.title.slice(0, 70),
        url: t.url.slice(0, 100),
      })),
    );
  },

  async mem() {
    // RSS is a high-water mark and says nothing about leaks; heapUsed after a
    // forced collection does. The daemon needs --expose-gc for gcForced: true.
    if (global.gc) global.gc();
    const m = process.memoryUsage();
    out({
      rssMb: +(m.rss / 1048576).toFixed(1),
      heapUsedMb: +(m.heapUsed / 1048576).toFixed(1),
      heapTotalMb: +(m.heapTotal / 1048576).toFixed(1),
      externalMb: +(m.external / 1048576).toFixed(1),
      gcForced: !!global.gc,
    });
  },

  async frames() {
    return withTab(async (cdp, sessionId) => {
      const frames = await listFrames(cdp, sessionId);
      out(frames.map((f) => ({ ref: `#f${f.index}`, depth: f.depth, url: f.url.slice(0, 110), name: f.name })));
    });
  },

  async open([url]) {
    if (!url) fail("usage: palmifer open <url>");
    const cdp = await getConn();
    const anon = await anonContext(cdp);
    const { targetId } = await cdp.send("Target.createTarget", {
      url,
      ...(anon ? { browserContextId: anon } : {}),
    });
    state.current = targetId;
    state.refs = {};
    if (!state.opened.includes(targetId)) state.opened.push(targetId);
    saveState(state);
    if (anon) {
      console.log("· anonymous context: this tab starts with no cookies and no logins (`palmifer anon off` to stop)");
    }
    noteHost(url);
    if (args["no-wait"]) {
      out({ opened: targetId, url, waited: false, anon: !!anon });
      return;
    }
    let sessionId = await attach(cdp, targetId);
    await waitReady(cdp, sessionId);
    await sleep(700);
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    sessionId = await reattach(cdp, targetId);
    await waitReady(cdp, sessionId);
    const title = await evaluate(cdp, sessionId, "document.title").catch(() => "");
    const href = await evaluate(cdp, sessionId, "location.href").catch(() => url);
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    await dwell(800, 1800);
    out({ opened: targetId, title, url: href, anon: !!anon });
  },

  async goto([url]) {
    if (!url) fail("usage: palmifer goto <url>");
    noteHost(url);
    return withTab(async (cdp, sessionId, target) => {
      await cdp.send("Page.navigate", { url }, sessionId);
      if (args["no-wait"]) {
        state.current = target.targetId;
        state.refs = {};
        state.refsTab = null;
        saveState(state);
        out({ tab: target.targetId, url, waited: false });
        return;
      }
      await waitReady(cdp, sessionId);
      await sleep(700);
      const fresh = await reattach(cdp, target.targetId);
      await waitReady(cdp, fresh);
      const final = await evaluate(cdp, fresh, "location.href");
      state.current = target.targetId;
      state.refs = {};
      state.refsTab = null;
      saveState(state);
      await cdp.send("Target.detachFromTarget", { sessionId: fresh }).catch(() => {});
      await dwell(800, 1800);
      out({ tab: target.targetId, url: final });
    });
  },

  async use([which]) {
    if (which) args.tab = which;
    const cdp = await getConn();
    const target = await resolveTab(cdp);
    state.current = target.targetId;
    state.refs = {};
    saveState(state);
    out({ current: target.targetId, title: target.title, url: target.url });
  },

  async snapshot() {
    const limit = Number(args.limit || 220);
    const nameRe = args.filter ? new RegExp(String(args.filter), "i") : null;
    const actionableOnly = !!args["actionable-only"];
    return withTab(async (cdp, sessionId, target) => {
      await cdp.send("Accessibility.enable", {}, sessionId).catch(() => {});
      const frame = await resolveFrame(cdp, sessionId);
      let nodes;
      try {
        ({ nodes } = await cdp.send(
          "Accessibility.getFullAXTree",
          frame ? { frameId: frame.id } : {},
          sessionId,
        ));
      } catch (e) {
        if (frame) fail(`frame snapshot failed: ${e.message}`);
        ({ nodes } = await cdp.send("Accessibility.getFullAXTree", {}, sessionId));
      }
      const byId = new Map(nodes.map((n) => [n.nodeId, n]));
      const lines = [];
      const refs = {};
      let n = 0;
      const walk = (id, depth) => {
        const node = byId.get(id);
        if (!node || n >= limit || depth > 16) return;
        const role = node.role?.value || "";
        const name = (node.name?.value || "").replace(/\s+/g, " ").trim();
        const actionable = ACTIONABLE.has(role);
        const structuralReadable =
          !actionable && !actionableOnly && name && role &&
          !["generic", "none", "InlineTextBox", "StaticText"].includes(role);
        const keep =
          !node.ignored && name && role &&
          (actionable || structuralReadable) &&
          (!nameRe || nameRe.test(name));
        if (keep) {
          n++;
          const ref = `@e${n}`;
          if (node.backendDOMNodeId) refs[ref] = node.backendDOMNodeId;
          lines.push(`${actionable ? "*" : " "}${ref} [${role}] ${name.slice(0, 140)}`);
        }
        const next = keep ? depth + 1 : depth;
        for (const c of node.childIds || []) walk(c, next);
      };
      for (const root of nodes.filter((x) => !x.parentId)) walk(root.nodeId, 0);
      state.current = target.targetId;
      state.refs = refs;
      state.refsTab = target.targetId;
      saveState(state);
      console.log(`# ${target.title}\n# ${target.url}${frame ? `\n# frame ${frame.url.slice(0, 90)}` : ""}`);
      console.log(lines.join("\n"));
      console.log(`# ${lines.length} nodes ( * = clickable/fillable )`);
    });
  },

  async text() {
    const max = Number(args.max || 6000);
    return withTab(async (cdp, sessionId, target) => {
      const frame = await resolveFrame(cdp, sessionId);
      const expr = `document.body ? document.body.innerText.replace(/\\n{3,}/g,'\\n\\n').slice(0,${max}) : ''`;
      let t;
      if (frame) {
        const c = await frameContext(cdp, sessionId, frame.id);
        t = c ? await evaluate(cdp, sessionId, expr, c.contextId) : "";
      } else {
        t = await evaluate(cdp, sessionId, expr);
      }
      console.log(`# ${target.title}\n${t}`);
    });
  },

  async eval([code]) {
    if (!code) fail("usage: palmifer eval '<js>'");
    if (!args["allow-network"] && /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket)\s*\(/.test(code)) {
      console.error(
        "· this eval talks to the network. palmifer exists to drive the page; read the rendered\n" +
          "  DOM (or `palmifer dom`) instead — that is what the site itself does, and it is the path\n" +
          "  that does not get rate-limited. Pass --allow-network when a call is genuinely the point.",
      );
    }
    return withTab(async (cdp, sessionId) => {
      const frame = await resolveFrame(cdp, sessionId);
      let v;
      if (frame) {
        const c = await frameContext(cdp, sessionId, frame.id);
        if (!c) fail(`no execution context for frame ${frame.url || frame.id}`);
        if (c.isolated) {
          console.log("# frame has no default realm; evaluated in an isolated world (page globals are not visible)");
        }
        v = await evaluate(cdp, sessionId, code, c.contextId);
      } else {
        v = await evaluate(cdp, sessionId, code);
      }
      out(typeof v === "string" ? v : JSON.stringify(v));
    });
  },

  async wait([target]) {
    if (!target && !args.text && !args.js) fail("usage: palmifer wait <css> | wait --text <str> | wait --js '<expr>'");
    const timeout = Number(args.timeout || 15000);
    const wantText = args.text ? String(args.text) : null;
    const wantJs = args.js ? String(args.js) : null;
    return withTab(async (cdp, sessionId) => {
      const frame = await resolveFrame(cdp, sessionId);
      const ctx = frame ? await frameContext(cdp, sessionId, frame.id) : null;
      const deadline = Date.now() + timeout;
      // --js is the escape hatch for "wait until the page has N of something",
      // which is what a lazy-loaded SPA list actually needs. Text and CSS
      // lookups pierce shadow roots so they work on web-component pages too.
      const expr = wantJs
        ? `(()=>{const v=(${wantJs});return !!v})()`
        : wantText
          ? `(()=>{${DEEP_JS} return __palmRoots().some(r=>__palmText(r.host||r).includes(${JSON.stringify(wantText)})||((r.body||r).innerText||"").includes(${JSON.stringify(wantText)}))})()`
          : `(()=>{${DEEP_JS} for(const r of __palmRoots()){ try{ if((r.body||r).querySelector(${JSON.stringify(target)})) return true }catch(e){} } return false})()`;
      while (Date.now() < deadline) {
        const ok = await evaluate(cdp, sessionId, expr, ctx ? ctx.contextId : undefined).catch(() => false);
        if (ok) {
          out({ ok: true, waitedMs: timeout - (deadline - Date.now()) });
          return;
        }
        await sleep(250);
      }
      fail(`wait timed out after ${timeout}ms: ${wantJs ? `js ${wantJs}` : wantText ? `text "${wantText}"` : target}`);
    });
  },

  async front() {
    // Explicit, not implicit: raising a window steals focus from whatever the
    // user is doing, so it is its own command rather than a side effect of click.
    return withTab(async (cdp, sessionId, target) => {
      await cdp.send("Page.bringToFront", {}, sessionId).catch(() => {});
      await sleep(250);
      const visibility = await evaluate(cdp, sessionId, "document.visibilityState").catch(() => "?");
      out({ tab: target.targetId, title: target.title.slice(0, 70), visibility });
    });
  },

  async dom([target]) {
    const selector = args.text ? null : target || args.selector;
    const text = args.text ? String(args.text) : null;
    if (!selector && !text) fail("usage: palmifer dom <css> | dom --text <str> [--exact] [--limit N]");
    return withTab(async (cdp, sessionId, t) => {
      const rows = await deepQuery(cdp, sessionId, {
        selector,
        text,
        exact: !!args.exact,
        limit: Number(args.limit || 20),
        within: args.within ? String(args.within) : null,
        all: !!args.all,
      });
      if (rows.length && rows[0].error) fail(`selector threw: ${rows[0].error}`);
      out(rows.length ? rows : { matched: 0, note: `nothing matched ${text ? `text "${text}"` : selector} (shadow roots included)` });
    });
  },

  async scroll([where]) {
    const dir = (where || "down").toLowerCase();
    if (!["down", "up", "bottom", "top"].includes(dir)) fail("usage: palmifer scroll <down|up|bottom|top> [--amount N] [--times N]");
    let amount = Number(args.amount || 900);
    if (dir === "up") amount = -Math.abs(amount);
    const times = Math.max(1, Number(args.times || 1));
    const maxSteps = dir === "bottom" || dir === "top" ? Math.max(times, Number(args.max || 30)) : times;
    return withTab(async (cdp, sessionId) => {
      await ensureVisible(cdp, sessionId);
      const [vw, vh] = await evaluate(cdp, sessionId, "[innerWidth, innerHeight]");
      const at = { x: Math.round(vw / 2), y: Math.round(vh / 2) };
      const y0 = await evaluate(cdp, sessionId, "Math.round(scrollY)");
      const h0 = await evaluate(cdp, sessionId, "document.body.scrollHeight");
      let steps = 0;
      let last = y0;
      for (let i = 0; i < maxSteps; i++) {
        // A wheel event is what a trackpad sends, so every scroll listener,
        // lazy loader and infinite-scroll hook on the page sees a real gesture.
        await cdp.send(
          "Input.dispatchMouseEvent",
          { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: dir === "up" || dir === "top" ? -Math.abs(amount) : Math.abs(amount) },
          sessionId,
        );
        steps++;
        await sleep(isHuman() ? rand(240, 620) : 130);
        const y = await evaluate(cdp, sessionId, "Math.round(scrollY)");
        if ((dir === "bottom" || dir === "top") && y === last) break; // stop when it stops moving
        last = y;
      }
      const y1 = await evaluate(cdp, sessionId, "Math.round(scrollY)");
      const h1 = await evaluate(cdp, sessionId, "document.body.scrollHeight");
      out({
        scrolled: dir,
        steps,
        scrollY: y1,
        moved: y1 - y0,
        pageHeight: h1,
        grewBy: h1 - h0,
        human: isHuman(),
      });
    });
  },

  async click([sel]) {
    if (!sel && !args.text) fail("usage: palmifer click <selector|@eN> | click --text <label> [--nth N]");
    if (args.frame) fail("--frame is supported by snapshot/text/eval/wait; click acts on the top document");
    return withTab(async (cdp, sessionId, target) => {
      await paceAction();
      if (args.text) {
        // Click the thing by what it says. On a page whose controls are JS
        // buttons with no href this is the only honest handle, and the two
        // calls below find it through shadow roots.
        const rect = await elementRectByText(cdp, sessionId, String(args.text), {
          nth: Number(args.nth || 1),
          exact: !!args.exact,
          within: args.within ? String(args.within) : null,
        });
        await trustedClickAt(cdp, sessionId, rect);
        out({
          clickedByText: String(args.text),
          what: `${rect.tag}${rect.cls ? "." + rect.cls.split(" ")[0] : ""}: ${rect.text}`,
          candidates: rect.candidates,
          interactive: rect.interactive,
          trusted: true,
          at: { x: Math.round(rect.x), y: Math.round(rect.y) },
        });
        return;
      }
      if (sel.startsWith("@e") && state.refsTab && state.refsTab !== target.targetId) {
        fail("@e refs were captured on another tab — run snapshot on this tab");
      }
      if (args.trusted || isHuman()) {
        // Real input events: pages that check event.isTrusted ignore el.click(),
        // and an eased pointer path is what the user's own hand looks like.
        const rect = await trustedClick(cdp, sessionId, sel);
        out({
          clicked: sel,
          trusted: true,
          human: isHuman(),
          at: { x: Math.round(rect.x), y: Math.round(rect.y) },
        });
        return;
      }
      if (sel.startsWith("@e")) {
        const backendNodeId = state.refs[sel];
        if (!backendNodeId) fail(`unknown ref ${sel} — run snapshot first`);
        const { object } = await cdp.send("DOM.resolveNode", { backendNodeId }, sessionId);
        const res = await cdp.send(
          "Runtime.callFunctionOn",
          {
            objectId: object.objectId,
            functionDeclaration:
              "function(){this.scrollIntoView({block:'center'});this.click();return this.tagName+':'+(this.innerText||this.value||'').slice(0,40)}",
            returnByValue: true,
          },
          sessionId,
        );
        out({ clicked: sel, what: res.result?.value });
      } else {
        const v = await evaluate(
          cdp,
          sessionId,
          `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'NOT_FOUND';el.scrollIntoView({block:'center'});el.click();return el.tagName+':'+(el.innerText||el.value||'').slice(0,40)})()`,
        );
        out({ clicked: sel, what: v });
      }
    });
  },

  async fill([sel, value]) {
    if (!sel || value === undefined) fail("usage: palmifer fill <selector|@eN> <value> [--fast]");
    if (args.frame) fail("--frame is supported by snapshot/text/eval/wait; fill acts on the top document");
    return withTab(async (cdp, sessionId, target) => {
      await paceAction();
      if (sel.startsWith("@e") && state.refsTab && state.refsTab !== target.targetId) {
        fail("@e refs were captured on another tab — run snapshot on this tab");
      }
      if (args.trusted || isHuman()) {
        // Focus the field with a real click, select what is there (the way a
        // person replaces a value), then type character by character.
        await trustedClick(cdp, sessionId, sel);
        await sleep(rand(90, 240));
        await evaluate(
          cdp,
          sessionId,
          `(()=>{const el=document.activeElement;if(!el)return false;
            if(el.select){el.select();return true}
            if(el.isContentEditable){const r=document.createRange();r.selectNodeContents(el);
              const s=getSelection();s.removeAllRanges();s.addRange(r);return true}
            return false})()`,
        ).catch(() => {});
        await sleep(rand(40, 120));
        await typeText(cdp, sessionId, String(value));
        out({ filled: sel, mode: "human-typed", human: isHuman() });
        return;
      }
      const fn = `function(v){
        const el=this; el.focus();
        if (el.isContentEditable) {
          document.execCommand('selectAll',false,null);
          document.execCommand('insertText',false,v);
          return 'contenteditable';
        }
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(el,v);
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
        return 'value';
      }`;
      let objectId;
      if (sel.startsWith("@e")) {
        const backendNodeId = state.refs[sel];
        if (!backendNodeId) fail(`unknown ref ${sel} — run snapshot first`);
        objectId = (await cdp.send("DOM.resolveNode", { backendNodeId }, sessionId)).object.objectId;
      } else {
        const { result } = await cdp.send(
          "Runtime.evaluate",
          { expression: `document.querySelector(${JSON.stringify(sel)})` },
          sessionId,
        );
        // Runtime.evaluate answers with {result}; a missing element has no objectId.
        if (!result || !result.objectId) fail(`selector not found: ${sel}`);
        objectId = result.objectId;
      }
      const res = await cdp.send(
        "Runtime.callFunctionOn",
        { objectId, functionDeclaration: fn, arguments: [{ value }], returnByValue: true },
        sessionId,
      );
      out({ filled: sel, mode: res.result?.value });
    });
  },

  async upload([sel, ...files]) {
    if (!sel || !files.length) fail("usage: palmifer upload <selector|@eN> <file...>");
    if (args.frame) fail("--frame is supported by snapshot/text/eval/wait; upload acts on the top document");
    return withTab(async (cdp, sessionId) => {
      await paceAction();
      if (sel.startsWith("@e")) {
        const backendNodeId = state.refs[sel];
        if (!backendNodeId) fail(`unknown ref ${sel} — run snapshot first`);
        await cdp.send("DOM.setFileInputFiles", { files, backendNodeId }, sessionId);
      } else {
        const { root } = await cdp.send("DOM.getDocument", {}, sessionId);
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel }, sessionId);
        if (!nodeId) fail(`selector not found: ${sel}`);
        await cdp.send("DOM.setFileInputFiles", { files, nodeId }, sessionId);
      }
      out({ uploaded: files, selector: sel });
    });
  },

  async screenshot([path]) {
    return withTab(async (cdp, sessionId, target) => {
      const params = { format: "jpeg", quality: 80 };
      if (args.full) {
        const m = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
        const s = m.cssContentSize || m.contentSize;
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, width: s.width, height: s.height, scale: 1 };
      }
      const { data } = await cdp.send("Page.captureScreenshot", params, sessionId);
      const outPath = path || join(process.env.TMPDIR || "/tmp", `palmifer-${Date.now()}.jpg`);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, Buffer.from(data, "base64"));
      out({ path: outPath, full: !!args.full, title: target.title });
    });
  },

  async pdf([path]) {
    return withTab(async (cdp, sessionId, target) => {
      const { data } = await cdp.send(
        "Page.printToPDF",
        { printBackground: true, paperWidth: 8.27, paperHeight: 11.69 },
        sessionId,
      );
      const outPath = path || join(process.env.TMPDIR || "/tmp", `palmifer-${Date.now()}.pdf`);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, Buffer.from(data, "base64"));
      out({ path: outPath, title: target.title });
    });
  },

  async cdp([method, paramsJson]) {
    if (!method) fail("usage: palmifer cdp <Domain.method> ['{json params}']");
    const cdp = await getConn();
    let params = {};
    if (paramsJson) {
      try {
        params = JSON.parse(paramsJson);
      } catch (e) {
        fail(`params must be JSON: ${e.message}`);
      }
    }
    if (args.browser) {
      out(JSON.stringify(await cdp.send(method, params)));
      return;
    }
    const target = await resolveTab(cdp);
    const sessionId = await attach(cdp, target.targetId);
    try {
      out(JSON.stringify(await cdp.send(method, params, sessionId)));
    } finally {
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  },

  async network([sub, requestId]) {
    const cdp = await getConn();
    if (sub === "start") {
      const target = await resolveTab(cdp);
      if (net) await cdp.send("Target.detachFromTarget", { sessionId: net.sessionId }).catch(() => {});
      if (!cdp.netHooked) {
        netEnsureHandler(cdp);
        cdp.netHooked = true;
      }
      const sessionId = await attach(cdp, target.targetId);
      await cdp.send("Network.enable", {}, sessionId);
      net = { sessionId, targetId: target.targetId, requests: new Map(), startedAt: Date.now() };
      out({ started: true, tab: target.targetId, title: target.title });
      return;
    }
    if (!net) fail("network capture is not running — `network start` first");
    if (sub === "stop") {
      await cdp.send("Target.detachFromTarget", { sessionId: net.sessionId }).catch(() => {});
      const count = net.requests.size;
      net = null;
      out({ stopped: true, captured: count });
      return;
    }
    if (sub === "list") {
      const filter = args.filter ? String(args.filter) : null;
      const list = [...net.requests.values()]
        .filter((r) => !filter || r.url.includes(filter))
        .map((r) => ({
          requestId: r.requestId,
          method: r.method,
          status: r.status,
          mimeType: r.mimeType,
          type: r.type,
          completed: r.completed,
          url: r.url.slice(0, 140),
        }));
      out({ count: list.length, requests: list.slice(0, Number(args.limit || 100)) });
      return;
    }
    if (sub === "detail") {
      const id = requestId;
      if (!id) fail("usage: palmifer network detail <requestId>");
      const r = net.requests.get(id);
      if (!r) fail(`no captured request ${id}`);
      let body = null;
      let bodyError = null;
      try {
        const res = await cdp.send("Network.getResponseBody", { requestId: id }, net.sessionId);
        body = res.base64Encoded ? `<base64 ${res.body.length} chars>` : res.body.slice(0, 4000);
      } catch (e) {
        bodyError = String(e.message || e);
      }
      out({
        requestId: id,
        url: r.url,
        status: r.status,
        mimeType: r.mimeType,
        requestHeaders: r.requestHeaders,
        responseHeaders: r.responseHeaders,
        body,
        bodyError,
      });
      return;
    }
    fail("usage: palmifer network <start|stop|list|detail>");
  },

  async press([key]) {
    if (!key) fail("usage: palmifer press <key>   e.g. Enter, Tab, Escape, ArrowDown, Meta+A");
    return withTab(async (cdp, sessionId) => {
      await paceAction();
      await ensureVisible(cdp, sessionId);
      const spec = keySpec(key);
      await cdp.send(
        "Input.dispatchKeyEvent",
        { type: spec.text === undefined ? "rawKeyDown" : "keyDown", ...spec },
        sessionId,
      );
      if (isHuman()) await sleep(rand(25, 90));
      await cdp.send(
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          key: spec.key,
          code: spec.code,
          windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
          nativeVirtualKeyCode: spec.vk,
          modifiers: spec.modifiers,
        },
        sessionId,
      );
      out({ pressed: key, human: isHuman() });
    });
  },

  async anon([sub]) {
    if (sub && !["on", "off", "status"].includes(sub)) fail("usage: palmifer anon <on|off|status>");
    const cdp = await getConn();
    const inContext = async (id) => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      return targetInfos.filter((t) => t.type === "page" && t.browserContextId === id);
    };

    if (sub === "status") {
      const live = await anonContext(cdp);
      const tabs = live ? (await inContext(live)).length : 0;
      out({
        anon: live,
        tabs,
        note: live
          ? "tabs opened now carry no cookies and no logins from your profile"
          : "off — new tabs use the normal profile",
      });
      return;
    }

    if (sub === "off") {
      const id = (state.anonContexts || {})[activeMode()];
      if (!id) {
        out({ anon: null, closedTabs: 0, note: "was not on" });
        return;
      }
      const tabs = (await inContext(id)).filter(() => true);
      const wasCurrent = tabs.some((t) => t.targetId === state.current);
      for (const t of tabs) await cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
      await cdp.send("Target.disposeBrowserContext", { browserContextId: id }).catch(() => {});
      delete state.anonContexts[activeMode()];
      if (wasCurrent) state.current = null;
      state.opened = state.opened.filter((o) => !tabs.some((t) => t.targetId === o));
      state.refs = {};
      saveState(state);
      out({ anon: null, closedTabs: tabs.length });
      return;
    }

    const live = await anonContext(cdp);
    if (live) {
      out({ anon: live, note: "already on" });
      return;
    }
    const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: false });
    state.anonContexts = state.anonContexts || {};
    state.anonContexts[activeMode()] = browserContextId;
    state.refs = {};
    saveState(state);
    out({
      anon: browserContextId,
      note:
        "on: every tab opened from now on gets a separate, empty cookie jar — no logins, " +
        "no history. Chrome opens it in its own window; `palmifer anon off` closes those tabs and returns to normal.",
    });
  },

  async browser([sub, arg]) {
    const URLISH = !sub || /^(https?:|about:|file:|data:)/.test(sub);
    const info = () => {
      const p = privateBrowser();
      return p
        ? {
            running: true,
            pid: p.pid,
            headless: p.headless,
            endpoint: p.endpoint,
            profileDir: p.profileDir,
            persistent: !!p.persistent,
            startedAt: p.startedAt,
          }
        : { running: false };
    };

    if (sub === "status" || args.status) {
      const p = privateBrowser();
      if (!p && activeMode() === "private") setMode("real"); // it died; do not report a mode we cannot honour
      // Never poke the user's browser just to answer a status question.
      const tabs = p ? await getConn().then((c) => pageTargets(c)).then((t) => t.length).catch(() => null) : null;
      out({
        mode: activeMode(),
        real: realEndpoint(),
        private: info(),
        tabs,
        note: p
          ? p.persistent
            ? `\`--profile-dir\` profile, kept across restarts (${p.profileDir})`
            : `use \`palmifer browser close\` to delete the throwaway profile (${p.profileDir})`
          : "`palmifer browser` starts a throwaway browser; without it palmifer drives your own",
      });
      return;
    }

    if (sub === "use") {
      const which = arg || "real";
      if (!["real", "private"].includes(which)) fail("usage: palmifer browser use <real|private>");
      if (which === "private" && !privateBrowser()) {
        fail("no throwaway browser is running — start one with `palmifer browser`");
      }
      setMode(which);
      resetConn();
      forgetTabs();
      out({ mode: which, endpoint: resolveEndpoint() });
      return;
    }

    if (sub === "close" || args.stop) {
      const p = readJson(PRIVATE_FILE);
      let stopped = false;
      let graceful = false;
      if (p && p.pid && pidAlive(p.pid)) {
        // Ask the browser to close itself first. A SIGTERM to the process group
        // works, but it interrupts the profile's writes: cookies and
        // localStorage set during the session may never reach disk, which is
        // exactly what a `--profile-dir` user is keeping the profile for.
        if (activeMode() === "private") {
          try {
            const cdp = await getConn();
            await cdp.send("Browser.close");
            graceful = true;
            for (let i = 0; i < 50 && pidAlive(p.pid); i++) await sleep(100);
          } catch {}
        }
      }
      if (p && p.pid && pidAlive(p.pid)) {
        // detached, so the pid is the process-group leader: one signal reaps the
        // whole browser, helper processes included.
        try {
          process.kill(-p.pid, "SIGTERM");
        } catch {
          try {
            process.kill(p.pid, "SIGTERM");
          } catch {}
        }
        for (let i = 0; i < 30 && pidAlive(p.pid); i++) await sleep(100);
        if (pidAlive(p.pid)) {
          try {
            process.kill(-p.pid, "SIGKILL");
          } catch {
            try {
              process.kill(p.pid, "SIGKILL");
            } catch {}
          }
        }
        stopped = true;
      }
      // Only ever delete a directory we created, and only one that looks like it.
      // `--profile-dir` profiles are the user's: closing the browser keeps them,
      // which is how a login survives on a server.
      let profileRemoved = false;
      let profileKept = null;
      const deletable =
        p && !p.persistent && typeof p.profileDir === "string" && p.profileDir.includes("palmifer-private-");
      if (deletable) {
        try {
          rmSync(p.profileDir, { recursive: true, force: true });
          profileRemoved = !existsSync(p.profileDir);
        } catch {}
      } else if (p && p.profileDir) {
        profileKept = p.profileDir;
      }
      rmSync(PRIVATE_FILE, { force: true });
      setMode("real");
      resetConn();
      delete state.anonContexts.private; // it died with the process we just killed
      forgetTabs();
      out({
        private: stopped ? "stopped" : "was not running",
        graceful,
        profileRemoved,
        ...(profileKept ? { profileKept, note: "kept on purpose: `--profile-dir` profiles hold your logins" } : {}),
        mode: "real",
        endpoint: resolveEndpoint(),
      });
      return;
    }

    if (sub && !URLISH) fail(`usage: palmifer browser [url] [--headed] [--profile-dir <dir>] | browser <status|close|use>`);

    const existing = privateBrowser();
    if (existing && !args.restart) {
      if (activeMode() !== "private") {
        setMode("private");
        resetConn();
        forgetTabs();
      }
      if (sub) {
        await commands.open([sub]);
        return;
      }
      out({ private: "already running", ...info(), mode: "private" });
      return;
    }

    const bin = browserBinary();
    if (!bin) {
      fail(
        "no Chrome/Chromium found to launch.\n" +
          "Install Chrome, or point at one: PALMIFER_CHROME=/path/to/chrome palmifer browser",
      );
    }
    // A crashed run leaves a temp profile behind; drop it before making a new one.
    const stale = readJson(PRIVATE_FILE);
    if (
      stale &&
      !stale.persistent &&
      stale.profileDir &&
      !pidAlive(stale.pid || 0) &&
      String(stale.profileDir).includes("palmifer-private-")
    ) {
      try {
        rmSync(stale.profileDir, { recursive: true, force: true });
      } catch {}
    }

    const headless = !args.headed;
    // `--profile-dir` (or PALMIFER_PROFILE_DIR) makes the profile permanent, so
    // a server can log in once and stay logged in across restarts.
    const wantedProfile = args["profile-dir"] || process.env.PALMIFER_PROFILE_DIR;
    const persistent = !!wantedProfile;
    const profileDir = persistent
      ? resolve(String(wantedProfile))
      : mkdtempSync(join(tmpdir(), "palmifer-private-"));
    const portFile = join(profileDir, "DevToolsActivePort");
    const targetUrl = sub && URLISH && sub !== "about:blank" ? sub : "about:blank";
    const platform = process.platform;
    const flags = chromeLaunchFlags({
      profileDir,
      url: targetUrl,
      headless,
      platform,
      noSandbox: sandboxUnavailable({
        platform,
        uid: typeof process.getuid === "function" ? process.getuid() : undefined,
        readFileSync,
      }),
      shmMb: platform === "linux" ? shmSizeMb(statfsSync, "/dev/shm") : null,
      extra: process.env.PALMIFER_CHROME_FLAGS || "",
    });

    if (args["dry-run"]) {
      out({
        dryRun: true,
        wouldRun: bin,
        args: flags,
        headless,
        profileDir,
        persistent,
        note: "nothing was launched and the active browser was not switched",
      });
      return;
    }

    mkdirSync(profileDir, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });
    const log = openSync(join(STATE_DIR, "private.log"), "a");
    const child = spawn(bin, flags, { detached: true, stdio: ["ignore", log, log] });
    child.unref();

    // A --profile-dir that has been used before still holds the DevToolsActivePort
    // of the *previous* run, pointing at a port that is long gone. Reading it back
    // would "find" an endpoint that cannot be connected to, so clear it first and
    // only trust a file Chrome wrote for this launch.
    rmSync(portFile, { force: true });

    let endpoint = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
        if (port && path) {
          const candidate = `ws://127.0.0.1:${port.trim()}${path.trim()}`;
          // Prove it is live before reporting success: private browsers need no
          // approval, so a plain connection here is cheap and side-effect free.
          if (await canConnect(candidate, 1500)) {
            endpoint = candidate;
            break;
          }
        }
      }
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    if (!endpoint) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      // Never delete a profile the user asked us to keep.
      if (!persistent) rmSync(profileDir, { recursive: true, force: true });
      fail(
        "the browser never opened a CDP port — see ~/.cache/palmifer/private.log\n" +
          "`palmifer browser --dry-run` prints the exact command line that was used.",
      );
    }

    writeJson(PRIVATE_FILE, { pid: child.pid, endpoint, headless, profileDir, persistent, startedAt: Date.now() });
    setMode("private");
    resetConn();
    forgetTabs();
    await sleep(200);
    const cdp = await getConn();
    const pages = await pageTargets(cdp);
    if (!pages.length) {
      // Chrome can come up with no window at all; give it one rather than
      // leaving every later command to fail with "no open tabs".
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      state.current = targetId;
      if (!state.opened.includes(targetId)) state.opened.push(targetId);
      saveState(state);
    }
    out({
      private: headless ? "running (headless)" : "running (windowed)",
      pid: child.pid,
      endpoint,
      profileDir,
      persistent,
      tabs: (await pageTargets(cdp)).length,
      note: persistent
        ? "this profile is permanent: log in once and it survives `browser close` and restarts."
        : "this browser is brand new: no logins, no cookies. `palmifer browser close` stops it and deletes the profile.",
    });
  },

  async close([which]) {
    const cdp = await getConn();
    // Chrome with zero page targets has no window: input has nowhere to land and
    // the browser looks broken to its owner. That is worth refusing once.
    const pagesBefore = await pageTargets(cdp);
    const guard = (n) => {
      if (pagesBefore.length - n <= 0 && !args.force) {
        fail(
          "that would close the last tab and leave Chrome with no window at all.\n" +
            "  Pass --force if you really mean it.",
        );
      }
    };
    if (args.mine) {
      const pages = await pageTargets(cdp);
      const mine = pages.filter((p) => state.opened.includes(p.targetId));
      guard(mine.length);
      for (const p of mine) await cdp.send("Target.closeTarget", { targetId: p.targetId });
      state.opened = state.opened.filter((id) => !mine.some((p) => p.targetId === id));
      if (mine.some((p) => p.targetId === state.current)) state.current = null;
      saveState(state);
      out({ closed: mine.length, tabs: mine.map((p) => p.title.slice(0, 50)) });
      return;
    }
    if (args.all) {
      const pages = await pageTargets(cdp);
      guard(pages.length);
      for (const p of pages) await cdp.send("Target.closeTarget", { targetId: p.targetId });
      state.current = null;
      state.refs = {};
      state.opened = [];
      saveState(state);
      out({ closed: pages.length });
      return;
    }
    if (which) args.tab = which;
    const target = await resolveTab(cdp);
    guard(1);
    await cdp.send("Target.closeTarget", { targetId: target.targetId });
    // A closed tab must leave the "opened by me" set, otherwise `close --mine`
    // keeps counting a tab that no longer exists.
    state.opened = state.opened.filter((id) => id !== target.targetId);
    if (state.current === target.targetId) state.current = null;
    saveState(state);
    out({ closed: target.targetId, title: target.title });
  },
};

// ---------------------------------------------------------------- daemon

function json(res, body, code = 200) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

async function runLocal(name, positional, localArgs) {
  // Rebind per request: a flag from the previous call must never leak forward.
  for (const k of Object.keys(args)) delete args[k];
  Object.assign(args, localArgs || {});
  const fn = commands[name];
  if (!fn) throw new Error(`unknown command: ${name}`);
  return fn(positional);
}

if (cmd === "__serve") {
  inDaemon = true;
  const token = ensureToken();
  let queue = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    if (host && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
      return json(res, { error: "forbidden host" }, 403);
    }
    if (req.url === "/health") return json(res, { ok: true, pid: process.pid });
    if (req.headers["x-palmifer-token"] !== token) return json(res, { error: "bad token" }, 401);
    if (req.url === "/stop") {
      if (req.method !== "POST") return json(res, { error: "stop requires POST" }, 405);
      json(res, { ok: true });
      setTimeout(() => process.exit(0), 50);
      return;
    }
    if (req.url !== "/run" || req.method !== "POST") return json(res, { error: "not found" }, 404);

    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return json(res, { ok: false, error: "bad request body" }, 400);
    }

    // One command at a time: args, the current tab, snapshot refs and the output
    // buffer are process-wide, so overlapping requests would corrupt each other.
    const task = queue.then(async () => {
      const buf = [];
      const origLog = console.log;
      const origErr = console.error;
      console.log = (...a) => buf.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
      console.error = (...a) => buf.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
      let error = null;
      try {
        await runLocal(body.cmd, body.positional || [], body.args || {});
      } catch (e) {
        error = String(e.message || e);
      } finally {
        console.log = origLog;
        console.error = origErr;
      }
      json(res, { ok: !error, output: buf.join("\n"), error });
    });
    queue = task.catch(() => {});
    await task;
  });
  server.listen(DAEMON_PORT, "127.0.0.1", () => {
    console.log(`[palmifer] daemon on 127.0.0.1:${DAEMON_PORT} pid ${process.pid}`);
    writeFileSync(PID_FILE, String(process.pid));
    writeJson(BUILD_FILE, { fingerprint: buildFingerprint(), pid: process.pid });
  });
  process.on("SIGTERM", () => process.exit(0));
} else if (cmd === "stop") {
  const stillUp = privateBrowser();
  if (stillUp) {
    console.error(
      `· note: the throwaway browser (pid ${stillUp.pid}) is still running and its profile is at\n` +
        `  ${stillUp.profileDir}\n  \`palmifer browser close\` stops it and deletes that profile.`,
    );
  }
  try {
    const r = await fetch(`http://127.0.0.1:${DAEMON_PORT}/stop`, {
      method: "POST",
      headers: { "x-palmifer-token": daemonToken() },
      signal: AbortSignal.timeout(5000),
    });
    out(await r.json());
  } catch {
    out({ ok: true, note: "daemon was not running" });
  }
} else if (cmd === "bench") {
  const i = argv.indexOf("bench");
  const child = spawn(process.execPath, [join(dirname(SELF), "bench.mjs"), ...argv.slice(i + 1)], {
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  // ---- thin client: make sure the daemon is up, then send the command ----
  async function healthy() {
    try {
      const r = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`, { signal: AbortSignal.timeout(1200) });
      return r.ok;
    } catch {
      return false;
    }
  }

  if (!(await healthy())) {
    mkdirSync(STATE_DIR, { recursive: true });
    // Only the user's own browser asks for permission; the throwaway one does not.
    console.error(
      activeMode() === "private"
        ? "· starting the local palmifer daemon"
        : "· starting the local palmifer daemon — if Chrome asks “Allow remote debugging?”, click Allow once",
    );
    ensureToken();
    const log = openSync(LOG_FILE, "a");
    const child = spawn(process.execPath, [SELF, "__serve"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.unref();
    for (let i = 0; i < 60 && !(await healthy()); i++) await sleep(250);
    if (!(await healthy())) fail("could not start the palmifer daemon (see ~/.cache/palmifer/daemon.log)");
  }

  const running = readJson(BUILD_FILE);
  const onDisk = buildFingerprint();
  if (running && onDisk && running.fingerprint && running.fingerprint !== onDisk) {
    console.error(
      "· the daemon is running older code than the CLI on disk — `palmifer stop` then retry\n" +
        "  (reloading the daemon costs one Chrome approval).",
    );
  }

  let data;
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-palmifer-token": daemonToken() },
      body: JSON.stringify({ cmd, positional: rest, args }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      fail(`daemon refused the command (HTTP ${res.status}): ${payload.error || "no detail"}`);
    }
    data = await res.json();
  } catch (e) {
    fail(`cannot reach the palmifer daemon on 127.0.0.1:${DAEMON_PORT}: ${e.message}`);
  }
  if (data.output) console.log(data.output);
  if (data.error) fail(data.error, 1);
}
