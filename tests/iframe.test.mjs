#!/usr/bin/env node
/**
 * iframe support: reading, acting, and the coordinates that connect the two.
 *
 * Chinese sites very often put the whole UI inside a same-origin content frame
 * (`#g_iframe` on music.163.com and friends). Before this suite existed, palmifer
 * could read such a frame but could not click or fill inside it, so the first
 * action of any task failed.
 *
 * Runs against an isolated daemon, state directory and throwaway headless
 * browser: the browser you use day to day is never contacted.
 *
 *   node tests/iframe.test.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "palmifer.mjs");
const STATE_DIR = mkdtempSync(join(tmpdir(), "palmifer-if-state-"));
const PORT = "8938";
const CROSS_PORT = "8939";
const ENV = { ...process.env, PALMIFER_STATE_DIR: STATE_DIR, PALMIFER_DAEMON_PORT: "8948" };
const BASE = `http://127.0.0.1:${PORT}`;

const DEEP = `<!doctype html><html><head><meta charset="utf-8"><title>deep</title></head><body style="margin:0">
<button id="deep-btn" style="margin:10px">深层按钮</button>
<div id="deep-out">idle</div>
<script>
  document.getElementById('deep-btn').addEventListener('click', function(e){
    document.getElementById('deep-out').textContent = e.isTrusted ? 'deep-clicked' : 'deep-synthetic';
  });
</script></body></html>`;

const INNER = `<!doctype html><html><head><meta charset="utf-8"><title>inner</title></head><body style="margin:0">
<button id="inner-btn" style="margin:15px">内层按钮</button>
<div id="inner-out">idle</div>
<input id="inner-input" style="margin-left:15px;width:220px" value="原有内容" />
<div id="deep-wrap" style="margin-left:15px;margin-top:20px;width:300px;height:120px">
  <iframe id="deep_frame" src="/deep" style="width:300px;height:120px;border:0"></iframe>
</div>
<script>
  document.getElementById('inner-btn').addEventListener('click', function(e){
    document.getElementById('inner-out').textContent = e.isTrusted ? 'inner-clicked' : 'inner-synthetic';
  });
</script></body></html>`;

const TOP = `<!doctype html><html><head><meta charset="utf-8"><title>top</title></head><body style="margin:0">
<button id="top-btn">顶层按钮</button>
<div id="wrap" style="margin-left:30px;margin-top:40px;width:520px;height:380px">
  <iframe id="g_iframe" src="/inner" style="width:520px;height:380px;border:0"></iframe>
</div>
<iframe id="cross_frame" src="http://127.0.0.1:${CROSS_PORT}/cross" style="width:200px;height:80px;border:0"></iframe>
</body></html>`;

const server = spawn(process.execPath, ["-e", `
  require("http").createServer((q, r) => {
    r.setHeader("content-type", "text/html; charset=utf-8");
    r.end(q.url.startsWith("/inner") ? ${JSON.stringify(INNER)} : q.url.startsWith("/deep") ? ${JSON.stringify(DEEP)} : ${JSON.stringify(TOP)});
  }).listen(${PORT}, "127.0.0.1");`], { stdio: "ignore" });

const crossServer = spawn(process.execPath, ["-e", `
  require("http").createServer((q, r) => {
    r.setHeader("content-type", "text/html; charset=utf-8");
    r.end('<!doctype html><title>cross</title><button id="cross-btn">跨源按钮</button>');
  }).listen(${CROSS_PORT}, "127.0.0.1");`], { stdio: "ignore" });

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

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--fast"], { env: ENV, encoding: "utf8", timeout: 180000 });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", text: `${r.stdout || ""}${r.stderr || ""}` };
}
const palmifer = (...args) => run(args);
const json = (r) => {
  const line = r.stdout.split("\n").find((l) => /^\s*[[{]/.test(l));
  try { return JSON.parse(line); } catch { return null; }
};
const evalIn = (args) => { const r = run(["eval", ...args]); return r.stdout.trim().split("\n").pop(); };

function cleanup() {
  try { spawnSync(process.execPath, [CLI, "browser", "close"], { env: ENV, timeout: 30000 }); } catch {}
  try { spawnSync(process.execPath, [CLI, "stop"], { env: ENV, timeout: 30000 }); } catch {}
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
  for (const s of [server, crossServer]) { try { s.kill("SIGKILL"); } catch {} }
}

try {
  await new Promise((r) => setTimeout(r, 600));
  palmifer("browser", BASE);

  console.log("\nframes are listed, and reading inside one already worked");
  const frames = json(palmifer("frames"));
  check("frames lists the top document", (frames || []).some((f) => f.depth === 0), JSON.stringify(frames));
  check("frames lists the same-origin content frame", (frames || []).some((f) => f.url.endsWith("/inner")), JSON.stringify(frames));
  check("frames lists the nested frame", (frames || []).some((f) => f.url.endsWith("/deep")), JSON.stringify(frames));
  check("text --frame reads the frame", run(["text", "--frame", "inner"]).stdout.includes("内层按钮"));
  check("snapshot --frame still reports the frame", run(["snapshot", "--frame", "inner", "--limit", "5"]).stdout.includes("# frame"), run(["snapshot", "--frame", "inner", "--limit", "5"]).stdout.slice(0, 120));
  check("dom without --frame stays on the top document", (json(run(["dom", "--text", "内层按钮"]))?.matched || 0) === 0);

  console.log("\ndiscovery inside a frame, in page coordinates");
  const innerDom = json(run(["dom", "--text", "内层按钮", "--frame", "inner"]));
  check("dom --frame finds a control in the frame", innerDom?.length === 1, JSON.stringify(innerDom));
  check("dom --frame reports page coordinates", innerDom?.[0]?.x > 40 && innerDom?.[0]?.y > 40, JSON.stringify(innerDom?.[0]));
  const deepDom = json(run(["dom", "--text", "深层按钮", "--frame", "deep"]));
  check("dom --frame reaches a nested frame", deepDom?.length === 1, JSON.stringify(deepDom));

  console.log("\nacting inside a frame, with real input events");
  const clickText = json(run(["click", "--text", "内层按钮", "--frame", "inner"]));
  check("click --text --frame succeeds", clickText?.trusted === true, JSON.stringify(clickText));
  check("the frame's own handler saw a trusted click", evalIn(["--frame", "inner", "document.getElementById('inner-out').textContent"]) === "inner-clicked");

  const clickSel = json(run(["click", "#inner-btn", "--frame", "inner"]));
  check("click <css> --frame succeeds", clickSel?.trusted === true, JSON.stringify(clickSel));
  check("the frame button is reachable by selector", evalIn(["--frame", "inner", "document.getElementById('inner-out').textContent"]) === "inner-clicked");

  const filled = json(run(["fill", "#inner-input", "新内容", "--frame", "inner"]));
  check("fill --frame reports real input", filled?.input === "real", JSON.stringify(filled));
  check("fill --frame replaced the value", evalIn(["--frame", "inner", "document.getElementById('inner-input').value"]) === "新内容");

  const deepClick = json(run(["click", "#deep-btn", "--frame", "deep"]));
  check("nested frame: click succeeds", deepClick?.trusted === true, JSON.stringify(deepClick));
  check("nested frame handler saw a trusted click", evalIn(["--frame", "deep", "document.getElementById('deep-out').textContent"]) === "deep-clicked");

  console.log("\ncoordinates: what dom reports, click-at accepts");
  const pagePoint = json(run(["dom", "--text", "内层按钮", "--frame", "inner"]))?.[0];
  const viaPage = json(run(["click-at", String(pagePoint.x), String(pagePoint.y)]));
  check("click-at takes the page point dom reported", viaPage?.trusted === true, JSON.stringify(viaPage));
  check("and it hit the frame's control", String(viaPage?.clickedAt?.x) === String(pagePoint.x), JSON.stringify([viaPage?.clickedAt, pagePoint]));

  const localPoint = JSON.parse(evalIn(["--frame", "inner", `JSON.stringify((r=>({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}))(document.getElementById('inner-btn').getBoundingClientRect()))`]));
  const viaFrame = json(run(["click-at", String(localPoint.x), String(localPoint.y), "--frame", "inner"]));
  check("click-at --frame takes frame-relative coordinates", viaFrame?.trusted === true, JSON.stringify(viaFrame));
  check("and resolves them to a page point", viaFrame?.clickedAt?.x > localPoint.x, JSON.stringify([viaFrame?.clickedAt, localPoint]));

  const inputPoint = JSON.parse(evalIn(["--frame", "inner", `JSON.stringify((r=>({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}))(document.getElementById('inner-input').getBoundingClientRect()))`]));
  const typed = json(run(["type-at", String(inputPoint.x), String(inputPoint.y), "替换文本", "--frame", "inner"]));
  check("type-at --frame reports a replace", typed?.replace === true, JSON.stringify(typed));
  check("type-at replaced instead of appending", evalIn(["--frame", "inner", "document.getElementById('inner-input').value"]) === "替换文本");

  console.log("\nwhat is out of reach says so");
  const cross = run(["click", "#cross-btn", "--frame", "cross"]);
  check("a cross-origin frame fails loudly", cross.code === 1, cross.text.slice(0, 160));
  check("and explains why", /cross-origin/.test(cross.text), cross.text.slice(0, 200));

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
} finally {
  cleanup();
}
