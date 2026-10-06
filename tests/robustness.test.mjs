#!/usr/bin/env node
/**
 * Regression tests for the failure modes two field sessions hit on real sites:
 *
 *   - a screenshot whose bytes did not match its extension, written relative to
 *     the daemon's directory instead of the caller's
 *   - `--fast` silently swapping real input events for synthetic ones
 *   - a `current` tab pointer left pointing at a tab someone else closed
 *   - `bench` crashing where `ps`/`pgrep` do not exist (agent sandboxes)
 *
 * Runs against an isolated daemon, state directory and throwaway headless
 * browser, so it never touches the daemon, tabs or logins of the palmifer in
 * day-to-day use.
 *
 *   node tests/robustness.test.mjs
 *
 * Requires Node >= 22 and an installed Chrome/Chromium.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "palmifer.mjs");
const SHIM = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "palmifer");
const STATE_DIR = mkdtempSync(join(tmpdir(), "palmifer-rb-state-"));
const WORK_DIR = mkdtempSync(join(tmpdir(), "palmifer-rb-cwd-"));
// macOS TMPDIR lives behind the /var -> /private/var symlink; process.cwd() reports
// the physical path, so compare like for like.
const WORK_REAL = realpathSync(WORK_DIR);
const PORT = "8936";
const ENV = { ...process.env, PALMIFER_STATE_DIR: STATE_DIR, PALMIFER_DAEMON_PORT: "8947" };
const BASE = `http://127.0.0.1:${PORT}`;

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>robustness</title></head><body>
<input id="q" />
<button id="safe">safe button</button>
<button id="trusted">trusted only</button>
<textarea id="ta">原有内容</textarea>
<div id="out">idle</div>
<div id="keys">0</div>
<div id="counter">0</div>
<button id="grows">grow</button>
<button id="fetchy">fetch</button>
<div style="height:1500px"></div>
<script>
  document.getElementById('safe').addEventListener('click', function(){ document.getElementById('out').textContent='safe-clicked'; });
  document.getElementById('trusted').addEventListener('click', function(e){
    document.getElementById('out').textContent = e.isTrusted ? 'trusted-input' : 'synthetic-input';
  });
  document.getElementById('ta').addEventListener('keydown', function(){
    var k=document.getElementById('keys'); k.textContent = String(Number(k.textContent)+1);
  });
  document.getElementById('fetchy').addEventListener('click', function(){ fetch('/api/ping').catch(function(){}); });
  document.getElementById('grows').addEventListener('click', function(){
    var c=document.getElementById('counter'); c.textContent = String(Number(c.textContent)+1);
    var d=document.createElement('div'); d.className='new-node'; document.body.appendChild(d);
  });
</script></body></html>`;

const probe = spawn(process.execPath, ["-e", `
  require("http").createServer((q,r)=>{
    if (q.url.startsWith("/api/ping")) { r.setHeader("content-type","application/json"); r.end(JSON.stringify({pong:true})); return; }
    r.setHeader("content-type","text/html; charset=utf-8"); r.end(${JSON.stringify(FIXTURE)});
  }).listen(${PORT},"127.0.0.1");`], { stdio: "ignore" });

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Run the CLI; keeps stdout and stderr apart, because the notice goes to stderr. */
function run(args, { cwd, env } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, env: { ...ENV, ...(env || {}) }, encoding: "utf8", timeout: 180000,
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", text: `${r.stdout || ""}${r.stderr || ""}` };
}
/** The CLI prints one JSON value on stdout. */
function json(r) {
  const line = r.stdout.split("\n").find((l) => /^\s*[[{]/.test(l));
  try { return JSON.parse(line); } catch { return null; }
}
const palmifer = (...args) => run([...args, "--fast"]);
const pjson = (...args) => json(palmifer(...args));
/** `eval` prints a bare string, so it needs its own reader. */
const evalText = (expr) => { const r = palmifer("eval", expr); return r.stdout.trim().split("\n").pop(); };

function cleanup() {
  try { spawnSync(process.execPath, [CLI, "browser", "close"], { env: ENV, timeout: 30000 }); } catch {}
  try { spawnSync(process.execPath, [CLI, "stop"], { env: ENV, timeout: 30000 }); } catch {}
  for (const d of [STATE_DIR, WORK_DIR]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  try { probe.kill("SIGKILL"); } catch {}
}

const magic = (file) => readFileSync(file).subarray(0, 4).toString("hex");
const isPng = (file) => existsSync(file) && magic(file) === "89504e47";
const isJpeg = (file) => existsSync(file) && magic(file).startsWith("ffd8ff");

try {
  await new Promise((r) => setTimeout(r, 500));
  const started = pjson("browser", BASE);
  check("throwaway browser is up", !!started?.endpoint, JSON.stringify(started));
  const currentTab = json(palmifer("tabs"))?.[0]?.id;

  console.log("\nscreenshot / pdf: bytes match the name, paths mean the caller's directory");
  const png = run(["screenshot", "rel.png", "--fast"], { cwd: WORK_DIR });
  const pngJson = json(png);
  check("relative path resolves against the caller's cwd", pngJson?.path === join(WORK_REAL, "rel.png"), pngJson?.path);
  check("reported path is absolute", String(pngJson?.path || "").startsWith("/"), pngJson?.path);
  check(".png really is PNG", isPng(join(WORK_DIR, "rel.png")), magic(join(WORK_DIR, "rel.png")));
  check("format is reported", pngJson?.format === "png", pngJson?.format);
  check("nothing landed in the daemon's own directory", !existsSync(join(process.cwd(), "rel.png")));

  const jpg = run(["screenshot", "shot.jpg", "--fast"], { cwd: WORK_DIR });
  check(".jpg really is JPEG", isJpeg(join(WORK_DIR, "shot.jpg")), magic(join(WORK_DIR, "shot.jpg")));
  check("jpeg format is reported", json(jpg)?.format === "jpeg", json(jpg)?.format);

  const funny = run(["screenshot", "notes.txt", "--fast"], { cwd: WORK_DIR });
  check("an extension that cannot hold the bytes is corrected", json(funny)?.path === join(WORK_REAL, "notes.png"), json(funny)?.path);
  check("corrected file exists and is PNG", isPng(join(WORK_DIR, "notes.png")));

  const noPath = palmifer("screenshot");
  check("no path still lands in the temp dir as PNG", isPng(json(noPath)?.path), json(noPath)?.path);

  const pdf = run(["pdf", "doc", "--fast"], { cwd: WORK_DIR });
  check("pdf gets a .pdf extension", json(pdf)?.path === join(WORK_REAL, "doc.pdf"), json(pdf)?.path);
  check("pdf bytes are a PDF", readFileSync(join(WORK_DIR, "doc.pdf")).subarray(0, 4).toString() === "%PDF");

  console.log("\ninput trust: --fast waits less, it does not change what the page receives");
  const normal = pjson("click", "#trusted");
  check("default click reports real input", normal?.input === "real" && normal?.trusted === true, JSON.stringify(normal));
  check("default click is acted on", evalText("document.querySelector('#out').textContent") === "trusted-input");

  palmifer("eval", "document.querySelector('#out').textContent='idle'");
  const fast = pjson("click", "#trusted");
  check("--fast click still reports real input", fast?.input === "real" && fast?.trusted === true, JSON.stringify(fast));
  check("--fast click is still acted on", evalText("document.querySelector('#out').textContent") === "trusted-input");

  const synth = pjson("click", "#trusted", "--synthetic");
  check("--synthetic says so in the output", synth?.input === "synthetic" && synth?.trusted === false, JSON.stringify(synth));
  check("--synthetic click is ignored by the page", evalText("document.querySelector('#out').textContent") === "synthetic-input");

  const filled = pjson("fill", "#ta", "新内容");
  check("--fast fill is real input", filled?.input === "real" && filled?.trusted === true, JSON.stringify(filled));
  check("--fast fill replaces the value", evalText("document.querySelector('#ta').value") === "新内容");
  const filledSynth = pjson("fill", "#ta", "覆盖", "--synthetic");
  check("--synthetic fill says so", filledSynth?.input === "synthetic", JSON.stringify(filledSynth));
  check("--synthetic fill replaces the value", evalText("document.querySelector('#ta').value") === "覆盖");

  console.log("\naction effects: what the caller would otherwise spend a second call to find out");
  const grew = pjson("click", "#grows");
  check("a click that changed the page reports it", grew?.effect?.domDelta > 0, JSON.stringify(grew?.effect));
  check("and reports no navigation", grew?.effect?.urlChanged === false, JSON.stringify(grew?.effect));
  const grewAgain = pjson("click", "#grows", "--verify", "#counter");
  check("--verify confirms a selector that is there", grewAgain?.effect?.verified === true, JSON.stringify(grewAgain?.effect));
  const flat = pjson("click", "#safe");
  check("a click with no visible effect says so", flat?.effect?.domDelta === 0 && flat?.effect?.urlChanged === false, JSON.stringify(flat?.effect));
  const notThere = pjson("click", "#safe", "--verify", "#never-there");
  check("--verify reports a selector that is not there", notThere?.effect?.verified === false, JSON.stringify(notThere?.effect));
  const filledEffect = pjson("fill", "#ta", "带效果");
  check("fill reports an effect too", filledEffect?.effect && typeof filledEffect.effect.domDelta === "number", JSON.stringify(filledEffect?.effect));
  const pressed = pjson("press", "Tab");
  check("press reports an effect", pressed?.effect && typeof pressed.effect.domDelta === "number", JSON.stringify(pressed?.effect));

  console.log("\ncurrent tab: a pointer someone else invalidated must not break every command");
  palmifer("open", `${BASE}/?doomed`);
  await new Promise((r) => setTimeout(r, 400));
  const before = json(palmifer("status"));
  const doomed = before?.current;
  const cdpPort = String(before?.endpoint || "").match(/:(\d+)\//)?.[1];
  check("a second tab became current", !!doomed && doomed !== currentTab, `${doomed} vs ${currentTab}`);
  spawnSync("curl", ["-s", `http://127.0.0.1:${cdpPort}/json/close/${doomed}`], { encoding: "utf8" });
  await new Promise((r) => setTimeout(r, 400));

  const stale = json(palmifer("status"));
  check("status stops calling a dead tab current", stale?.current === null || stale?.current !== doomed, JSON.stringify(stale.current));
  check("status names the stale pointer", stale?.currentStale?.id === doomed, JSON.stringify(stale?.currentStale));

  const recovered = run(["screenshot", "/tmp/palmifer-rb-recover.png", "--fast"]);
  check("the next command still works", recovered.code === 0, recovered.text.slice(0, 200));
  check("and says it fell back", /fell back/.test(recovered.text), recovered.text.slice(0, 240));

  const explicit = run(["dom", "body", "--tab", doomed, "--fast"]);
  check("an explicit --tab that cannot resolve still fails", explicit.code === 1, explicit.text.slice(0, 200));
  check("the failure names the next step", /palmifer tabs/.test(explicit.text) && /palmifer use/.test(explicit.text), explicit.text.slice(0, 200));

  console.log("\nbench: RSS is decoration, never a reason to fail");
  // A PATH with the tools the shim needs but without ps/pgrep — an agent sandbox.
  const BINDIR = join(STATE_DIR, "bin");
  mkdirSync(BINDIR, { recursive: true });
  for (const tool of ["bash", "dirname", "curl", "jq", "cat"]) {
    const found = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found) spawnSync("ln", ["-sf", found, join(BINDIR, tool)]);
  }
  const psGone = spawnSync("ps", ["-p", "1"], { env: { PATH: BINDIR }, encoding: "utf8" }).status !== 0;
  check("the test really removes ps/pgrep from PATH", psGone);
  const bench = run(["bench", "--runs", "1", "--warmup", "0", "--json"], {
    env: { PATH: BINDIR, PALMIFER_MIN_GAP_MS: "0" },
  });
  check("bench survives without ps/pgrep", bench.code === 0, bench.text.slice(0, 300));
  check("bench reports no RSS instead of inventing one", /"daemonRssMb":\s*null/.test(bench.text), bench.text.slice(-200));
  const benchJson = (() => { const i = bench.text.indexOf("{"); try { return JSON.parse(bench.text.slice(i)); } catch { return null; } })();
  const httpFails = (benchJson?.results || []).reduce((n, r) => n + ((r.paths?.http?.failed) || 0), 0);
  check("bench measures its own daemon, with the right token", httpFails === 0, JSON.stringify((benchJson?.results || []).map((r) => r.paths?.http?.errors).filter(Boolean)));

  console.log("\nan explicit --timeout is not cut short by an ambient budget");
  const t0 = Date.now();
  const longWait = run(["wait", "--js", "false", "--timeout", "2500"], { env: { PALMIFER_CMD_BUDGET_MS: "1200" } });
  const waited = Date.now() - t0;
  check("an ambient budget no longer beats --timeout", /wait timed out after 2500ms/.test(longWait.text), longWait.text.slice(0, 160));
  check("and the wait really ran for its timeout", waited >= 2400, `${waited}ms`);

  console.log("\nscreenshot options: a smaller image, and labels you can act on");
  const scaled = json(run(["screenshot", join(WORK_DIR, "scaled.png"), "--scale", "0.5", "--fast"]));
  check("--scale is reported", scaled?.scale === 0.5, JSON.stringify(scaled));
  const pngSize = (file) => { const b = readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
  const full = pngSize(join(WORK_DIR, "rel.png"));
  const half = pngSize(join(WORK_DIR, "scaled.png"));
  check("--scale really scales the pixels", half.w < full.w && half.w > 1, JSON.stringify([full, half]));
  const capped = json(run(["screenshot", join(WORK_DIR, "capped.png"), "--max-width", "200", "--fast"]));
  check("--max-width caps the width", pngSize(join(WORK_DIR, "capped.png")).w <= 200, JSON.stringify([capped, pngSize(join(WORK_DIR, "capped.png"))]));
  run(["snapshot", "--limit", "5", "--fast"]);
  const annotated = json(run(["screenshot", join(WORK_DIR, "annot.png"), "--annotate", "--fast"]));
  check("--annotate numbers what the snapshot found", annotated?.annotated >= 1, JSON.stringify(annotated));
  check("--annotate leaves the page as it found it", evalText("String(!!document.getElementById('__palm_annot'))") === "false");

  console.log("\neval --file, network row numbers, and what goto replaced");
  const script = join(WORK_DIR, "extract.js");
  writeFileSync(script, "JSON.stringify({ title: document.title, nodes: document.getElementsByTagName('*').length })");
  const fromFile = run(["eval", "--file", script, "--fast"]);
  check("eval --file runs a script from disk", /"title"/.test(fromFile.stdout), fromFile.text.slice(0, 160));
  const missing = run(["eval", "--file", join(WORK_DIR, "nope.js"), "--fast"]);
  check("eval --file names a missing file", missing.code === 1 && /cannot read --file/.test(missing.text), missing.text.slice(0, 160));

  palmifer("network", "start");
  palmifer("click", "#fetchy");
  await new Promise((r) => setTimeout(r, 500));
  const netList = json(palmifer("network", "list", "--filter", "ping"));
  check("network list numbers its rows", netList?.requests?.[0]?.i === 0, JSON.stringify(netList));
  const byIndex = json(palmifer("network", "detail", String(netList?.requests?.[0]?.i)));
  check("network detail takes the row number", byIndex?.requestId === netList?.requests?.[0]?.requestId, JSON.stringify(byIndex?.requestId));
  check("network detail still returns the body", /pong/.test(byIndex?.body || ""), String(byIndex?.body).slice(0, 80));
  palmifer("network", "stop");

  const went = json(palmifer("goto", `${BASE}/?after`));
  check("goto reports the URL it replaced", String(went?.previousUrl || "").startsWith(BASE), JSON.stringify(went));

  console.log("\nhousekeeping: logs stay bounded, forgotten browsers get reclaimed");
  check("daemon.log exists for debugging", existsSync(join(STATE_DIR, "daemon.log")));

  console.log("\nshim: same daemon, same state directory, same flag parsing");
  const haveShimTools = spawnSync("bash", ["-c", "command -v jq && command -v curl"], { encoding: "utf8" }).status === 0;
  if (!haveShimTools) {
    console.log("  skip  shim checks (jq or curl missing)");
  } else {
    const shimStatus = spawnSync("bash", [SHIM, "status"], { env: ENV, encoding: "utf8", timeout: 60000 });
    check("shim authenticates against an isolated state dir", json({ stdout: shimStatus.stdout })?.ok === true, `${shimStatus.stdout}${shimStatus.stderr}`.slice(0, 200));
    const shimClick = spawnSync("bash", [SHIM, "click", "#safe", "--verify", "#counter", "--fast"], { env: ENV, encoding: "utf8", timeout: 60000 });
    check("shim parses --verify as a value, not a bare flag", json({ stdout: shimClick.stdout })?.effect?.verified === true, `${shimClick.stdout}${shimClick.stderr}`.slice(0, 200));
    const shimWait = spawnSync("bash", [SHIM, "wait", "--js", "false", "--timeout", "1500"], { env: ENV, encoding: "utf8", timeout: 60000 });
    check("shim parses --timeout as a value, not a bare flag", /timed out after 1500ms/.test(`${shimWait.stdout}${shimWait.stderr}`), `${shimWait.stdout}${shimWait.stderr}`.slice(0, 200));
  }

  console.log("\nhousekeeping on a fresh daemon: rotate an oversized log, reclaim an idle browser");
  const STATE2 = mkdtempSync(join(tmpdir(), "palmifer-rb-house-"));
  const ENV2 = {
    ...ENV,
    PALMIFER_STATE_DIR: STATE2,
    PALMIFER_DAEMON_PORT: "8949",
    PALMIFER_LOG_MAX_BYTES: "1",
    PALMIFER_PRIVATE_IDLE_MIN: "0.05", // three seconds
    PALMIFER_PRIVATE_IDLE_CHECK_MS: "1000",
  };
  const run2 = (args) => spawnSync(process.execPath, [CLI, ...args, "--fast"], { env: ENV2, encoding: "utf8", timeout: 120000 });
  try {
    mkdirSync(STATE2, { recursive: true });
    writeFileSync(join(STATE2, "private.log"), "x".repeat(4096));
    run2(["browser", BASE]);
    const rotatedLog = readFileSync(join(STATE2, "private.log"), "utf8");
    check("an oversized private.log is rotated, not appended to forever", rotatedLog.includes("rotated at") && rotatedLog.length < 2000, `${rotatedLog.length} bytes`);
    await new Promise((r) => setTimeout(r, 5000));
    const stillThere = existsSync(join(STATE2, "private.json"));
    check("an idle throwaway browser is closed", !stillThere, "private.json still present");
    const afterStatus = JSON.parse(spawnSync(process.execPath, [CLI, "status"], { env: ENV2, encoding: "utf8" }).stdout || "{}");
    check("status still answers, and says which half is missing", afterStatus.daemon === true && afterStatus.reachable === false, JSON.stringify(afterStatus));
    const afterMouse = spawnSync(process.execPath, [CLI, "dom", "body", "--fast"], { env: ENV2, encoding: "utf8", timeout: 60000 });
    check("and the next command says how to get a browser back", /palmifer browser/.test(afterMouse.stderr + afterMouse.stdout), `${afterMouse.stdout}${afterMouse.stderr}`.slice(0, 200));
  } finally {
    spawnSync(process.execPath, [CLI, "stop"], { env: ENV2, timeout: 30000 });
    try { rmSync(STATE2, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
} finally {
  cleanup();
}
