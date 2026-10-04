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
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromeLaunchFlags, sandboxUnavailable } from "../bin/launch-flags.mjs";

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
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>palmifer fixture</title></head><body>
<h1>cookie probe</h1>
<div id="tools">
  <button id="lbl">下一页</button>
  <div id="out">idle</div>
  <div id="lazy"></div>
  <div id="shadowhost"></div>
</div>
<div style="height:3000px"></div>
`;
// A page with a shadow-DOM control, a label-only button, a late element and a
// tall body: exactly the shapes that broke the first real collection run.
const FIXTURE_BODY = FIXTURE + `<script>
  setTimeout(function(){document.getElementById('lazy').textContent='appeared';}, 1000);
  document.getElementById('lbl').addEventListener('click', function(){document.getElementById('out').textContent='clicked-by-text';});
  var host=document.getElementById('shadowhost');
  var sr=host.attachShadow({mode:'open'});
  sr.innerHTML='<button id="in-shadow">开始试炼</button>';
  sr.querySelector('#in-shadow').addEventListener('click', function(){document.getElementById('out').textContent='clicked-in-shadow';});
</script></body></html>`;
const probeServer = spawn(
  process.execPath,
  [
    "-e",
    `require("http").createServer((q,r)=>{r.setHeader("content-type","text/html");r.end(${JSON.stringify(FIXTURE_BODY)})}).listen(${PORT},"127.0.0.1")`,
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

  // The launch flags are the part that has to be right on a Linux VPS, where
  // this test cannot run. Every input is explicit, so every combination is
  // asserted here instead.
  console.log("\nlaunch flags (Linux/container combinations are asserted, not guessed)");
  const flagsFor = (o) => chromeLaunchFlags({ profileDir: "/p", ...o });
  check("headless by default", flagsFor({}).includes("--headless=new"));
  check("--headed drops it", !flagsFor({ headless: false }).some((f) => f.startsWith("--headless")));
  check("profile dir is passed through", flagsFor({ profileDir: "/data/p" }).includes("--user-data-dir=/data/p"));
  check("linux + root gets --no-sandbox", flagsFor({ platform: "linux", noSandbox: true }).includes("--no-sandbox"));
  check("linux + normal user keeps the sandbox", !flagsFor({ platform: "linux" }).includes("--no-sandbox"));
  check("macOS never gets --no-sandbox", !flagsFor({ platform: "darwin", noSandbox: true }).includes("--no-sandbox"));
  check("small /dev/shm gets --disable-dev-shm-usage", flagsFor({ platform: "linux", shmMb: 64 }).includes("--disable-dev-shm-usage"));
  check("roomy /dev/shm does not", !flagsFor({ platform: "linux", shmMb: 2048 }).includes("--disable-dev-shm-usage"));
  check("unknown /dev/shm does not", !flagsFor({ platform: "linux", shmMb: null }).includes("--disable-dev-shm-usage"));
  check("PALMIFER_CHROME_FLAGS is appended", flagsFor({ extra: "--lang=zh-CN --window-size=1280,900" }).includes("--lang=zh-CN"));
  check("url stays last", flagsFor({ url: "https://x.test/" }).at(-1) === "https://x.test/");
  check("root is detected on linux", sandboxUnavailable({ platform: "linux", uid: 0, readFileSync }) === true);
  check("non-root with userns on is fine", sandboxUnavailable({ platform: "linux", uid: 1000, readFileSync }) === false);
  check(
    "userns-off kernel needs --no-sandbox",
    sandboxUnavailable({ platform: "linux", uid: 1000, readFileSync: () => "0\n" }) === true,
  );
  check("missing userns knob is not treated as broken", sandboxUnavailable({ platform: "linux", uid: 1000, readFileSync: () => { throw new Error("ENOENT"); } }) === false);
  check("macOS sandbox is never reported unavailable", sandboxUnavailable({ platform: "darwin", uid: 0, readFileSync }) === false);

  console.log("\nbrowser --dry-run prints the command line and launches nothing");
  const dry = palmifer("browser", "--dry-run", "--profile-dir", join(STATE_DIR, "dry-profile"));
  check("dry run is marked as such", dry.json?.dryRun === true, dry.text);
  check("dry run reports the binary", /Chrome|Chromium/.test(dry.json?.wouldRun || ""), dry.json?.wouldRun);
  check("dry run reports a headless command line", (dry.json?.args || []).includes("--headless=new"));
  check("dry run reports the profile dir", dry.json?.profileDir === join(STATE_DIR, "dry-profile"), dry.json?.profileDir);
  check("dry run started nothing", !existsSync(join(STATE_DIR, "private.json")), "private.json exists");
  check("dry run did not switch browser", palmifer("browser", "status").json?.mode === "real");


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

  console.log("\ndriver primitives: scroll / click --text / wait / dom");
  palmifer("open", PROBE_URL);
  const scrolled = palmifer("scroll", "down", "--amount", "500");
  check("scroll moves the page with real wheel events", (scrolled.json?.moved || 0) > 0, scrolled.text);
  const toBottom = palmifer("scroll", "bottom");
  check("scroll bottom reaches the end", (toBottom.json?.scrollY || 0) > 1000, toBottom.text);
  const toTop = palmifer("scroll", "top");
  check("scroll top returns to the start", toTop.json?.scrollY === 0, toTop.text);

  const inShadow = palmifer("dom", "--text", "开始试炼");
  check("dom --text pierces the shadow root", Array.isArray(inShadow.json) && inShadow.json.some((r) => r.shadow === true), inShadow.text);
  const byText = palmifer("click", "--text", "开始试炼");
  check("click --text found the shadow control", /clicked|button/i.test(byText.json?.what || ""), byText.text);
  const afterShadowClick = palmifer("eval", "document.getElementById('out').textContent");
  check("click --text really activated it", afterShadowClick.text.includes("clicked-in-shadow"), afterShadowClick.text);

  const byLabel = palmifer("click", "--text", "下一页");
  check("click --text matches a label-only button", byLabel.json?.clickedByText === "下一页", byLabel.text);
  const afterLabelClick = palmifer("eval", "document.getElementById('out').textContent");
  check("the label-only button was clicked", afterLabelClick.text.includes("clicked-by-text"), afterLabelClick.text);

  const waited = palmifer("wait", "--js", "document.getElementById('lazy').textContent==='appeared'", "--timeout", "5000");
  check("wait --js resolves when a condition becomes true", waited.json?.ok === true, waited.text);
  const waitedText = palmifer("wait", "--text", "appeared", "--timeout", "3000");
  check("wait --text takes a value (regression: it used to search for \"true\")", waitedText.json?.ok === true, waitedText.text);
  const timedOut = palmifer("wait", "--text", "never-appears-xyz", "--timeout", "800");
  check("wait still times out loudly", timedOut.code !== 0 && /timed out/.test(timedOut.text), timedOut.text);

  const guard = palmifer("eval", "fetch('http://127.0.0.1:1/')");
  check("eval warns when the code uses the network", /talks to the network/.test(guard.text), guard.text);
  const guarded = palmifer("eval", "--allow-network", "1+1");
  check("--allow-network silences the warning", !/talks to the network/.test(guarded.text), guarded.text);

  const beforeTouch = palmifer("status");
  check("no staleness warning while the daemon matches the file", !/older code/.test(beforeTouch.text), beforeTouch.text);
  const touches = new Date(Date.now() + 5000);
  utimesSync(CLI, touches, touches);
  const afterTouch = palmifer("status");
  check("touching the file (same content) does not warn", !/older code/.test(afterTouch.text), afterTouch.text);
  const originalCli = readFileSync(CLI, "utf8");
  try {
    writeFileSync(CLI, originalCli + "\n// simulated edit by the test\n");
    const afterEdit = palmifer("status");
    check("daemon warns when the CLI content changed under it", /older code/.test(afterEdit.text), afterEdit.text);
  } finally {
    writeFileSync(CLI, originalCli);
  }

  console.log("\nback to the user's browser, then shut everything down");
  const priv = JSON.parse(readFileSync(join(STATE_DIR, "private.json"), "utf8"));
  const withFront = palmifer("scroll", "down", "--amount", "200", "--front");
  check("--front is accepted on input commands", (withFront.json?.moved || 0) > 0, withFront.text);
  const front = palmifer("front");
  check("front raises the tab and reports it visible", front.json?.visibility === "visible", front.text);
  const lastTab = palmifer("close", "--all");
  check("closing the last tab is refused (Chrome would have no window)", lastTab.code !== 0 && /no window/.test(lastTab.text), lastTab.text);
  const stillOpen = palmifer("status");
  check("...and nothing was closed", stillOpen.json?.tabs > 0, JSON.stringify(stillOpen.json));

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

  // This is the server story: log in once, keep the profile, stay logged in
  // across a full browser restart. The cookie is the login.
  console.log("\n--profile-dir keeps the profile, and the login in it, across restarts");
  const permDir = join(STATE_DIR, "perm-profile");
  const first = palmifer("browser", "--profile-dir", permDir, PROBE_URL);
  check("persistent profile reported as persistent", first.json?.persistent === true, first.text);
  check("persistent profile is not a temp dir", !/palmifer-private-/.test(first.json?.profileDir || ""), first.json?.profileDir);
  // max-age matters: a plain document.cookie is a *session* cookie and is
  // supposed to die with the browser, so it would prove nothing here.
  const permCookie = palmifer("eval", `document.cookie="palmifer_persist=1;max-age=86400;path=/";document.cookie`);
  check("cookie set inside the persistent profile", permCookie.text.includes("palmifer_persist=1"), permCookie.text);
  const permLocal = palmifer("eval", `localStorage.setItem("palmifer_token","abc");localStorage.getItem("palmifer_token")`);
  check("localStorage written in the persistent profile", permLocal.text.includes("abc"), permLocal.text);
  const permClosed = palmifer("browser", "close");
  check("closing keeps a --profile-dir profile", permClosed.json?.profileRemoved === false, JSON.stringify(permClosed.json));
  check("closing says which profile it kept", permClosed.json?.profileKept === permDir, permClosed.json?.profileKept);
  check("profile really is still on disk", existsSync(join(permDir, "DevToolsActivePort")) || existsSync(join(permDir, "Default")), permDir);

  const second = palmifer("browser", "--profile-dir", permDir, PROBE_URL);
  check("browser restarted on the same profile", second.json?.persistent === true, second.text);
  const survived = palmifer("eval", "document.cookie");
  check("the cookie survived a full browser restart", survived.text.includes("palmifer_persist=1"), survived.text);
  const survivedLocal = palmifer("eval", `localStorage.getItem("palmifer_token")`);
  check("localStorage survived a full browser restart", survivedLocal.text.includes("abc"), survivedLocal.text);
  // Graceful shutdown is what makes the two checks above possible: SIGTERM to
  // the process group kills the profile's writes before they reach disk.
  const permClosed2 = palmifer("browser", "close");
  check("close asked the browser to shut down gracefully", permClosed2.json?.graceful === true, JSON.stringify(permClosed2.json));
  const permGone = palmifer("browser", "status");
  check("after the last close there is no private browser", permGone.json?.private?.running === false);
} catch (e) {
  failures++;
  console.error(`\nunexpected error: ${e.stack || e}`);
} finally {
  cleanup();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
