#!/usr/bin/env node
/**
 * palmifer bench — how long does a command actually take on this machine?
 *
 * Three layers are measured separately, because they have three different causes:
 *
 *   cold   daemon spawn + CDP connect + first answer (the daemon is stopped first)
 *   shim   bin/palmifer (curl + jq), end to end, including the process it starts
 *   cli    bin/palmifer.mjs, the same command with Node's startup added
 *   http   the daemon's own POST /run round trip — no process spawn at all
 *
 * Reading the table: `cli - shim` is what Node's startup costs, `shim - http` is what
 * starting curl+jq costs, and `http` is close to the real CDP round trip.
 *
 * Usage:
 *   palmifer bench [--runs N] [--command "status"|"eval 1+1"|...] [--json] [--cold]
 *
 * Only read-only commands are benchmarked by default (status, tabs, eval). Nothing
 * here clicks, types or navigates, so it is safe to run against a live browser.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "palmifer");
const CLI = join(HERE, "palmifer.mjs");
const PORT = Number(process.env.PALMIFER_DAEMON_PORT || 8798);
const TOKEN_FILE = join(homedir(), ".cache", "palmifer", "token");

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const wantCold = argv.includes("--cold");
const runsArg = argv.indexOf("--runs");
const RUNS = runsArg >= 0 ? Math.max(1, Number(argv[runsArg + 1]) || 8) : 8;
const cmdArg = argv.indexOf("--command");
const COMMANDS = cmdArg >= 0
  ? [argv.slice(cmdArg + 1).join(" ")]
  : ["status", "tabs", "eval 1+1"];

const token = () => {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
};

/** Run `argv` as a child process and return its wall time in ms, or null on failure. */
function timeProcess(file, args) {
  const t0 = performance.now();
  const r = spawnSync(file, args, { stdio: ["ignore", "pipe", "pipe"] });
  const ms = performance.now() - t0;
  return r.status === 0 ? ms : null;
}

/** Ask the daemon directly — no process spawn, so this is nearly pure IPC + CDP. */
async function timeHttp(command) {
  const [cmd, ...rest] = command.split(" ");
  const t0 = performance.now();
  const r = await fetch(`http://127.0.0.1:${PORT}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-palmifer-token": token() },
    body: JSON.stringify({ cmd, args: {}, positional: rest }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await r.json();
  const ms = performance.now() - t0;
  return body.error ? null : ms;
}

async function series(fn, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ms = await fn();
    if (ms !== null) out.push(ms);
  }
  return out;
}

function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: xs.length,
    min: s[0],
    med: s[Math.floor(s.length / 2)],
    max: s[s.length - 1],
  };
}

const f = (ms) => (ms === null ? "—" : ms >= 100 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(1)} ms`);

// ---------------------------------------------------------------- run

// Read the browser facts first, and fail with the tool's own message if Chrome
// is not reachable — a benchmark of a broken connection is worse than useless.
const probe = spawnSync(process.execPath, [CLI, "status"], { encoding: "utf8" });
let info = null;
try {
  info = JSON.parse(probe.stdout);
} catch {
  process.stderr.write(probe.stderr || probe.stdout);
  process.exit(probe.status || 1);
}

const cwd = process.cwd();
const results = [];
for (const command of COMMANDS) {
  const parts = command.split(" ");
  const rows = {
    command,
    shim: stats(await series(() => timeProcess(SHIM, parts), RUNS)),
    cli: stats(await series(() => timeProcess(process.execPath, [CLI, ...parts]), RUNS)),
    http: stats(await series(() => timeHttp(command), RUNS)),
  };
  results.push(rows);
}

// Cold is opt-in, because restarting the daemon makes Chrome treat it as a new
// client and ask for approval again — any click lands inside the measurement.
let cold = null;
if (wantCold) {
  spawnSync(process.execPath, [CLI, "stop"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  cold = timeProcess(process.execPath, [CLI, "status"]);
  spawnSync(SHIM, ["status"], { stdio: "ignore" });
}

if (asJson) {
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform} ${process.arch}`, browser: info.browser, tabs: info.tabs, runs: RUNS, cold, results }, null, 2));
} else {
  console.log(`palmifer bench — ${RUNS} runs per cell, read-only commands only`);
  console.log(`node ${process.version} · ${process.platform} ${process.arch} · ${info.browser} · ${info.tabs} tabs · cwd ${cwd}`);
  console.log("");
  console.log("command".padEnd(14) + "path".padEnd(7) + "min".padStart(11) + "median".padStart(11) + "max".padStart(11));
  for (const r of results) {
    for (const path of ["shim", "cli", "http"]) {
      const s = r[path];
      console.log(
        r.command.padEnd(14) + path.padEnd(7) +
        f(s?.min).padStart(11) + f(s?.med).padStart(11) + f(s?.max).padStart(11),
      );
    }
  }
  console.log("");
  console.log(cold === null
    ? "cold start: skipped (pass --cold to measure it; Chrome may ask you to approve the new client, and your click would land in the number)"
    : `cold start (daemon spawn + CDP connect + first answer): ${f(cold)}`);
  console.log("");
  console.log("cli − shim ≈ Node startup · shim − http ≈ curl+jq startup · http ≈ CDP round trip");
}
