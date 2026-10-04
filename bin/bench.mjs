#!/usr/bin/env node
/**
 * palmifer bench — measure what a caller actually waits for.
 *
 * Tools like this usually quote IPC latency ("~50 ms"), which is not the number a
 * caller experiences. This measures whole calls, splits them into the layers that
 * have different causes, and reports a distribution instead of one lucky run.
 *
 * Methodology
 *   · one child process per measured call; wall time from a monotonic clock
 *   · `--warmup N` calls per cell are discarded before sampling
 *   · paths are measured in rotation (shim, cli, http, ...) so drift over the run
 *     — CPU ramp, page state — spreads across paths instead of biasing one
 *   · failures are counted and reported, never dropped from the sample
 *   · `--full` generates a fixed fixture page (300 rows + a form), pins every
 *     command to that tab, measures the write paths, then closes the tab
 *   · `--json` emits every raw sample so anyone can recompute the statistics
 *
 * What it does NOT measure: network time, page load, or any command that
 * navigates a page it did not open.
 *
 * Usage
 *   palmifer bench [--runs N] [--warmup N] [--full] [--json] [--cold]
 *
 * `--cold` is opt-in: it restarts the daemon, Chrome treats that as a new client
 * and asks for approval again, and your click lands inside the measurement.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "palmifer");
const CLI = join(HERE, "palmifer.mjs");
const PORT = Number(process.env.PALMIFER_DAEMON_PORT || 8798);
const TOKEN_FILE = join(homedir(), ".cache", "palmifer", "token");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const AS_JSON = flag("--json");
const WANT_COLD = flag("--cold");
const FULL = flag("--full") || flag("--writes-only");
const WRITES_ONLY = flag("--writes-only");
const RUNS = Math.max(1, Number(value("--runs", 25)) || 25);
const WARMUP = Math.max(0, Number(value("--warmup", 3)) || 3);

const token = () => {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------- fixture

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8">
<title>palmifer bench fixture</title></head><body>
<h1>Benchmark fixture</h1>
<form id="f"><input id="q" placeholder="query" aria-label="query">
<button id="go" type="submit">Search</button></form>
<p id="out">idle</p><ul id="list"></ul>
<script>
  const list = document.getElementById('list');
  for (let i = 0; i < 300; i++) {
    const li = document.createElement('li');
    li.innerHTML = '<a href="#row' + i + '">row ' + i + '</a> ' +
                   '<button aria-label="act ' + i + '">act</button>';
    list.appendChild(li);
  }
  document.getElementById('f').addEventListener('submit', (e) => {
    e.preventDefault();
    document.getElementById('out').textContent = 'searched: ' + document.getElementById('q').value;
  });
</script></body></html>`;

// ---------------------------------------------------------------- measuring

/** One child process, wall time from a monotonic clock. */
function childCall(bin, args) {
  const t0 = performance.now();
  const r = spawnSync(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const ms = performance.now() - t0;
  const ok = r.status === 0;
  return { ms, ok, err: ok ? null : r.stderr.toString().trim().split("\n")[0] || `exit ${r.status}` };
}

/** The daemon's own round trip: no process spawn, so this is close to raw CDP. */
async function httpCall(cmdText, extraArgs) {
  const [cmd, ...rest] = cmdText.split(" ");
  const t0 = performance.now();
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-palmifer-token": token() },
      body: JSON.stringify({ cmd, args: extraArgs, positional: rest }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await r.json();
    return { ms: performance.now() - t0, ok: !body.error, err: body.error || null };
  } catch (e) {
    return { ms: performance.now() - t0, ok: false, err: String(e.message || e) };
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function stats(samples) {
  const ok = samples.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  const errors = [...new Set(samples.filter((x) => !x.ok).map((x) => x.err).filter(Boolean))].slice(0, 3);
  const failed = samples.length - ok.length;
  if (!ok.length) return { n: 0, failed, errors, min: null, p50: null, p90: null, max: null, mean: null, sd: null, samples: [] };
  const mean = ok.reduce((a, b) => a + b, 0) / ok.length;
  const sd = Math.sqrt(ok.reduce((a, b) => a + (b - mean) ** 2, 0) / ok.length);
  return {
    n: ok.length,
    failed,
    errors,
    min: ok[0],
    p50: percentile(ok, 50),
    p90: percentile(ok, 90),
    max: ok[ok.length - 1],
    mean,
    sd,
    samples: ok.map((x) => Number(x.toFixed(2))),
  };
}

const fmt = (v) => (v === null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(1)} ms`);

// ---------------------------------------------------------------- environment

const statusRun = spawnSync(process.execPath, [CLI, "status"], { encoding: "utf8" });
let info = null;
try {
  info = JSON.parse(statusRun.stdout);
} catch {
  process.stderr.write(statusRun.stderr || statusRun.stdout);
  process.exit(statusRun.status || 1);
}

const daemonPid = spawnSync("pgrep", ["-f", "palmifer.mjs __serve"], { encoding: "utf8" }).stdout.trim().split("\n")[0];
const daemonRss = daemonPid
  ? Number(spawnSync("ps", ["-p", daemonPid, "-o", "rss="], { encoding: "utf8" }).stdout.trim()) / 1024
  : null;

// ---------------------------------------------------------------- matrix

const READ = [
  { label: "status", args: ["status"], cmd: "status" },
  { label: "tabs", args: ["tabs"], cmd: "tabs" },
  { label: "eval 1+1", args: ["eval", "1+1"], cmd: "eval 1+1" },
  { label: "text", args: ["text"], cmd: "text" },
  { label: "snapshot --actionable-only", args: ["snapshot", "--actionable-only"], cmd: "snapshot --actionable-only" },
  { label: "snapshot", args: ["snapshot"], cmd: "snapshot" },
  { label: "screenshot", args: ["screenshot", join(tmpdir(), "palmifer-bench.png")], cmd: `screenshot ${join(tmpdir(), "palmifer-bench.png")}` },
];
const WRITES = [
  { label: "fill --fast", args: ["fill", "#q", "hi", "--fast"], cmd: "fill #q hi --fast" },
  { label: "click --fast", args: ["click", "#go", "--fast"], cmd: "click #go --fast" },
  { label: "fill (paced)", args: ["fill", "#q", "hi"], cmd: "fill #q hi" },
  { label: "click (paced)", args: ["click", "#go"], cmd: "click #go" },
];

// ---------------------------------------------------------------- run

let tab = null;
let fixtureDir = null;

const cleanup = () => {
  if (tab) spawnSync(SHIM, ["close", tab], { stdio: "ignore" });
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function once(command, path) {
  const extra = tab ? { tab } : {};
  if (path === "http") return httpCall(command.cmd, extra);
  const args = path === "shim" ? command.args : [CLI, ...command.args];
  const bin = path === "shim" ? SHIM : process.execPath;
  return childCall(bin, tab ? [...args, "--tab", tab] : args);
}

async function measure(command, paths, runs) {
  const perPath = new Map(paths.map((p) => [p, []]));
  for (let i = 0; i < WARMUP; i++) for (const p of paths) await once(command, p);
  for (let i = 0; i < runs; i++) {
    // Rotate the order so drift is shared by every path, not owned by one.
    const order = paths.map((_, k) => paths[(k + i) % paths.length]);
    for (const p of order) perPath.get(p).push(await once(command, p));
  }
  const row = { command: command.label, paths: {} };
  for (const p of paths) row.paths[p] = stats(perPath.get(p));
  return row;
}

if (FULL) {
  fixtureDir = mkdtempSync(join(tmpdir(), "palmifer-bench-"));
  const file = join(fixtureDir, "fixture.html");
  writeFileSync(file, FIXTURE);
  const opened = spawnSync(SHIM, ["open", `file://${file}`], { encoding: "utf8" });
  if (opened.status !== 0) {
    process.stderr.write(opened.stderr || "could not open the fixture page\n");
    process.exit(1);
  }
  tab = JSON.parse(opened.stdout).opened;
  await new Promise((r) => setTimeout(r, 800));
}

const results = [];
if (!WRITES_ONLY) for (const command of READ) results.push(await measure(command, ["shim", "cli", "http"], RUNS));
for (const command of WRITES) {
  const runs = command.label.includes("paced") ? 5 : Math.min(RUNS, 10);
  results.push(await measure(command, ["shim"], runs));
}

let cold = null;
if (WANT_COLD) {
  spawnSync(process.execPath, [CLI, "stop"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [CLI, "status"], { stdio: "ignore" });
  cold = r.status === 0 ? performance.now() - t0 : null;
}

// ---------------------------------------------------------------- report

const env = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  browser: info.browser,
  protocol: info.protocol,
  tabs: info.tabs,
  target: FULL ? "generated fixture page (300 rows + form), tab pinned per call" : "the current tab, whatever it is",
  daemonRssMb: daemonRss ? Number(daemonRss.toFixed(1)) : null,
  samplesPerCell: RUNS,
  warmupCallsPerCell: WARMUP,
};

if (AS_JSON) {
  console.log(JSON.stringify({ env, cold, results }, null, 2));
} else {
  console.log("palmifer bench");
  console.log(`  ${env.node} · ${env.platform} · ${env.browser} · ${env.tabs} tabs${env.daemonRssMb ? ` · daemon ${env.daemonRssMb} MB RSS` : ""}`);
  console.log(`  target: ${env.target}`);
  console.log(`  ${env.samplesPerCell} samples per cell after ${env.warmupCallsPerCell} discarded warm-up calls; path order rotates to share drift`);
  console.log("");
  console.log(
    "command".padEnd(30) + "path".padEnd(7) + "n".padStart(4) + "fail".padStart(6) +
      "p50".padStart(11) + "p90".padStart(11) + "max".padStart(11) + "sd".padStart(9),
  );
  let capSeen = false;
  for (const row of results) {
    for (const [path, s] of Object.entries(row.paths)) {
      console.log(
        row.command.padEnd(30) + path.padEnd(7) + String(s.n).padStart(4) + String(s.failed).padStart(6) +
          fmt(s.p50).padStart(11) + fmt(s.p90).padStart(11) + fmt(s.max).padStart(11) +
          (s.sd === null ? "—" : s.sd.toFixed(1)).padStart(9),
      );
    }
    // A failure must be explained, never just counted.
    for (const [path, s] of Object.entries(row.paths)) {
      for (const e of s.errors || []) {
        if (/action cap/i.test(e)) capSeen = true;
        console.log(`  ↳ ${path}: ${s.failed} refused — ${e.split("\n")[0]}`);
      }
    }
    console.log("");
  }
  if (capSeen) {
    console.log("note: the burst guard refused some writes — that is the guard working, not a tool failure.");
    console.log("      It allows 80 write actions per 10 minutes per daemon. To measure paced writes back to");
    console.log("      back, start the daemon once with PALMIFER_ACTION_CAP=10000 and re-run.");
    console.log("");
  }
  console.log(cold === null
    ? "cold start: not measured — `--cold` restarts the daemon, Chrome asks for approval again,\n            and your click would be inside the number"
    : `cold start (daemon spawn + CDP connect + first answer): ${fmt(cold)}`);
  console.log("");
  console.log("cli − shim ≈ Node startup · shim − http ≈ curl + jq + one process · http ≈ CDP round trip");
  console.log("paced rows are the design budget, not a regression: spacing, per-character typing, eased pointer");
}

cleanup();
