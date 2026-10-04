#!/usr/bin/env node
/**
 * End-to-end test for the two ways palmifer can get a browser:
 *
 *   `palmifer browser`  a throwaway Chrome in a fresh temp profile (headless)
 *   `palmifer anon`     a cookie-less context inside whichever browser is in use
 *
 * It runs against an ISOLATED daemon and state directory, so it never touches
 * the daemon, state or tabs of the palmifer you use day to day, and it never
 * connects to your own browser: everything happens in the throwaway instance.
 *
 * The anonymity check is a real cookie: set it in the normal context, confirm
 * it survives reopening there, then confirm the anonymous context cannot see
 * it — and that turning anonymity off brings the cookie back. A test that only
 * asserted "anonContext != null" would pass on a broken implementation.
 *
 *   node tests/private-mode.test.mjs
 *
 * Requires Node >= 22 and an installed Chrome/Chromium.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "palmifer.mjs");
const STATE_DIR = mkdtempSync(join(tmpdir(), "palmifer-test-state-"));
const PORT = "8931";
const ENV = { ...process.env, PALMIFER_STATE_DIR: STATE_DIR, PALMIFER_DAEMON_PORT: "8799" };
const PROBE_URL = `http://127.0.0.1:${PORT}/`;

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Run the CLI and parse its JSON output (the CLI prints one JSON value). */
function palmifer(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--fast"], { env: ENV, encoding: "utf8", timeout: 120000 });
  const text = `${r.stdout || ""}${r.stderr || ""}`.trim();
  const line = text.split("\n").find((l) => /^[[{]/.test(l.trim()));
  let json = null;
  if (line) {
    try {
      json = JSON.parse(line);
    } catch {}
  }
  return { code: r.status, text, json };
}

function palmiferRaw(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: ENV, encoding: "utf8", timeout: 120000 });
  return `${r.stdout || ""}${r.stderr || ""}`.trim();
}

// The probe server must live in its own process: every palmifer call here is
// spawnSync, which blocks this process's event loop, so a server in-process
// could never answer the page the browser is trying to load.
const probeServer = spawn(
  process.execPath,
  [
    "-e",
    `require("http").createServer((q,r)=>{r.setHeader("content-type","text/html");r.end("<h1>cookie probe</h1>")}).listen(${PORT},"127.0.0.1")`,
  ],
  { stdio: "ignore" },
);

function cleanup() {
  try {
    spawnSync(process.execPath, [CLI, "browser", "close"], { env: ENV, timeout: 30000 });
  } catch {}
  try {
    spawnSync(process.execPath, [CLI, "stop"], { env: ENV, timeout: 30000 });
  } catch {}
  try {
    rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {}
  try {
    probeServer.kill("SIGKILL");
  } catch {}
}

try {
  await new Promise((r) => setTimeout(r, 600));
  console.log(`state dir: ${STATE_DIR}`);

  console.log("\nthrowaway browser (headless, no opt-in, no login)");
  const start = palmifer("browser");
  check("browser starts and reports a private endpoint", !!start.json?.endpoint, start.text);
  check("browser is headless by default", /headless/.test(start.json?.private || ""), start.json?.private);
  check("browser names its temp profile", /palmifer-private-/.test(start.json?.profileDir || ""));
  check("browser created a tab", start.json?.tabs >= 1, String(start.json?.tabs));

  const status = palmifer("status");
  check("mode is private", status.json?.mode === "private", JSON.stringify(status.json));
  check("status names the browser product", /Chrome|Chromium/.test(status.json?.browser || ""), status.json?.browser);
  check("no anonymous context yet", status.json?.anonContext === null);

  const realTabsBefore = palmiferRaw("tabs");
  check("daemon is talking to the throwaway browser", realTabsBefore.includes("about:blank"), realTabsBefore);

  console.log("\npage work in the throwaway browser");
  palmifer(
    "open",
    `data:text/html,<form onsubmit="document.title=document.getElementById('q').value;return false"><input id=q></form>`,
  );
  palmifer("fill", "#q", "hello");
  palmifer("press", "Enter");
  const title = palmifer("eval", "document.title");
  check("press Enter reached the page", title.text.includes("hello"), title.text);

  console.log("\nanonymous context isolates cookies");
  palmifer("open", PROBE_URL);
  const setCookie = palmifer("eval", `document.cookie="palmifer_probe=1";document.cookie`);
  check("cookie set in the normal context", setCookie.text.includes("palmifer_probe=1"), setCookie.text);
  palmifer("open", PROBE_URL);
  const stillThere = palmifer("eval", "document.cookie");
  check("cookie persists in the normal context", stillThere.text.includes("palmifer_probe=1"), stillThere.text);

  const on = palmifer("anon", "on");
  check("anon on returns a context id", /^[0-9A-F]{32}$/.test(on.json?.anon || ""), JSON.stringify(on.json));
  const onAgain = palmifer("anon", "on");
  check("anon on is idempotent", onAgain.json?.anon === on.json?.anon, `${onAgain.json?.anon} vs ${on.json?.anon}`);

  palmifer("open", PROBE_URL);
  const anonCookies = palmifer("eval", "document.cookie");
  check("anonymous tab cannot see the cookie", !anonCookies.text.includes("palmifer_probe"), anonCookies.text);
  const anonSet = palmifer("eval", `document.cookie="palmifer_anon=1";document.cookie`);
  check("anonymous tab can set its own cookie", anonSet.text.includes("palmifer_anon=1"), anonSet.text);

  const tabs = palmifer("tabs");
  const list = Array.isArray(tabs.json) ? tabs.json : [];
  check("tabs mark the anonymous ones", list.some((t) => t.anon === true), JSON.stringify(list.map((t) => t.anon)));
  check("normal tabs stay unmarked", list.some((t) => t.anon === false));

  const anonStatus = palmifer("anon", "status");
  check("anon status counts its tabs", anonStatus.json?.tabs >= 1, JSON.stringify(anonStatus.json));

  const off = palmifer("anon", "off");
  check("anon off closes its tabs", off.json?.anon === null, JSON.stringify(off.json));
  palmifer("open", PROBE_URL);
  const backToNormal = palmifer("eval", "document.cookie");
  check("normal context kept its own cookie", backToNormal.text.includes("palmifer_probe=1"), backToNormal.text);
  const gone = palmifer("eval", 'document.cookie.includes("palmifer_anon")');
  check("anonymous cookie did not leak into the normal context", gone.text.includes("false"), gone.text);

  console.log("\nback to the user's browser, then shut everything down");
  const priv = JSON.parse(readFileSync(join(STATE_DIR, "private.json"), "utf8"));
  const closed = palmifer("browser", "close");
  check("browser close reports the profile removed", closed.json?.profileRemoved === true, JSON.stringify(closed.json));
  check("mode returns to real", closed.json?.mode === "real", JSON.stringify(closed.json));

  await new Promise((r) => setTimeout(r, 800));
  let alive = true;
  try {
    process.kill(priv.pid, 0);
  } catch {
    alive = false;
  }
  check("throwaway browser process is gone", !alive, `pid ${priv.pid} still alive`);
  let profileGone = false;
  try {
    readFileSync(join(priv.profileDir, "DevToolsActivePort"), "utf8");
  } catch {
    profileGone = true;
  }
  check("temp profile was deleted", profileGone, priv.profileDir);

  const finalStatus = palmifer("browser", "status");
  check("status no longer sees a private browser", finalStatus.json?.private?.running === false, finalStatus.text);
} catch (e) {
  failures++;
  console.error(`\nunexpected error: ${e.stack || e}`);
} finally {
  cleanup();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
