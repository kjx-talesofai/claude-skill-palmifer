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
 * Commands (run `palmifer help`):
 *   status | tabs | frames | use <tab> | open <url> | goto <url>
 *   snapshot | text | click | fill | eval | wait | upload
 *   screenshot | pdf | network <start|stop|list|detail> | cdp <method> [json]
 *   close [tab] [--mine|--all] | stop
 *   bench [--runs N] [--command "status"] [--json]   measure real latency
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
 *   --browser                cdp: send at browser level instead of the tab
 *   --port <cdpPort>         override the discovered CDP port
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
const STATE_DIR = join(homedir(), ".cache", "palmifer");
const STATE_FILE = join(STATE_DIR, "state.json");
const PID_FILE = join(STATE_DIR, "daemon.pid");
const LOG_FILE = join(STATE_DIR, "daemon.log");
const DAEMON_PORT = Number(process.env.PALMIFER_DAEMON_PORT || 8798);
const INSPECT_HINT =
  "Chrome remote debugging is not enabled (or was switched off).\n" +
  "Open this in the browser you want to control and tick the box:\n" +
  '  chrome://inspect/#remote-debugging -> "Allow remote debugging for this browser instance"\n' +
  "Chrome will ask you to approve the connecting app once — click Allow.";

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
const VALUED = new Set(["tab", "frame", "limit", "max", "port", "session", "filter", "timeout", "seconds"]);
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
  for (const f of discoveryCandidates()) {
    if (!existsSync(f)) continue;
    const [port, path] = readFileSync(f, "utf8").trim().split("\n");
    if (port && path) return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
  }
  return null;
}

// ---------------------------------------------------------------- state

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!Array.isArray(s.opened)) s.opened = [];
    return s;
  } catch {
    return { current: null, refs: {}, opened: [] };
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
  const rect = await elementRect(cdp, sessionId, sel);
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
    if (this.closed) return Promise.reject(new Error(INSPECT_HINT));
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

async function getConn() {
  if (conn && !conn.closed) return conn;
  const url = resolveEndpoint();
  if (!url) fail(INSPECT_HINT, 2);
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error(`cannot reach Chrome at ${url}\n${INSPECT_HINT}`)), { once: true });
    const t = setTimeout(() => rej(new Error(INSPECT_HINT)), 120000);
    ws.addEventListener("open", () => clearTimeout(t), { once: true });
  });
  conn = new Cdp(ws);
  return conn;
}

async function pageTargets(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  return targetInfos.filter((t) => t.type === "page");
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

const commands = {
  async status() {
    const cdp = await getConn();
    const v = await cdp.send("Browser.getVersion");
    const pages = await pageTargets(cdp);
    out({
      ok: true,
      endpoint: resolveEndpoint(),
      browser: v.product,
      protocol: v.protocolVersion,
      tabs: pages.length,
      current: state.current,
      openedByMe: state.opened.length,
      networkCapturing: !!net,
      daemon: true,
    });
  },

  async tabs() {
    const cdp = await getConn();
    const pages = await pageTargets(cdp);
    out(
      pages.map((t, i) => ({
        i,
        id: t.targetId,
        current: t.targetId === state.current,
        mine: state.opened.includes(t.targetId),
        title: t.title.slice(0, 70),
        url: t.url.slice(0, 100),
      })),
    );
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
    const { targetId } = await cdp.send("Target.createTarget", { url });
    state.current = targetId;
    state.refs = {};
    if (!state.opened.includes(targetId)) state.opened.push(targetId);
    saveState(state);
    noteHost(url);
    if (args["no-wait"]) {
      out({ opened: targetId, url, waited: false });
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
    out({ opened: targetId, title, url: href });
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
    if (!target && !args.text) fail("usage: palmifer wait <css> | wait --text <str>");
    const timeout = Number(args.timeout || 15000);
    const wantText = args.text ? String(args.text) : null;
    return withTab(async (cdp, sessionId) => {
      const frame = await resolveFrame(cdp, sessionId);
      const ctx = frame ? await frameContext(cdp, sessionId, frame.id) : null;
      const deadline = Date.now() + timeout;
      const expr = wantText
        ? `document.body.innerText.includes(${JSON.stringify(wantText)})`
        : `!!document.querySelector(${JSON.stringify(target)})`;
      while (Date.now() < deadline) {
        const ok = await evaluate(cdp, sessionId, expr, ctx ? ctx.contextId : undefined).catch(() => false);
        if (ok) {
          out({ ok: true, waitedMs: timeout - (deadline - Date.now()) });
          return;
        }
        await sleep(250);
      }
      fail(`wait timed out after ${timeout}ms: ${wantText ? `text "${wantText}"` : target}`);
    });
  },

  async click([sel]) {
    if (!sel) fail("usage: palmifer click <selector|@eN> [--fast]");
    if (args.frame) fail("--frame is supported by snapshot/text/eval/wait; click acts on the top document");
    return withTab(async (cdp, sessionId, target) => {
      await paceAction();
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

  async close([which]) {
    const cdp = await getConn();
    if (args.mine) {
      const pages = await pageTargets(cdp);
      const mine = pages.filter((p) => state.opened.includes(p.targetId));
      for (const p of mine) await cdp.send("Target.closeTarget", { targetId: p.targetId });
      state.opened = state.opened.filter((id) => !mine.some((p) => p.targetId === id));
      if (mine.some((p) => p.targetId === state.current)) state.current = null;
      saveState(state);
      out({ closed: mine.length, tabs: mine.map((p) => p.title.slice(0, 50)) });
      return;
    }
    if (args.all) {
      const pages = await pageTargets(cdp);
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
    await cdp.send("Target.closeTarget", { targetId: target.targetId });
    if (state.current === target.targetId) {
      state.current = null;
      saveState(state);
    }
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
  });
  process.on("SIGTERM", () => process.exit(0));
} else if (cmd === "stop") {
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
    console.error(
      "· starting the local palmifer daemon — if Chrome asks “Allow remote debugging?”, click Allow once",
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
