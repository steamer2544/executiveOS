// End-to-end test for the browser-wasm transcription mode (Phase 25).
// Runs a REAL headless Chromium (Playwright) and feeds it fake microphone audio
// (the classic jfk.wav) via --use-file-for-fake-audio-capture, then asserts the
// dashboard records → transcribes in-browser (offline, WASM CPU) → emits system.note.
// Also checks the single Language selector persists to config.
//
// Run with node (NOT bun — Playwright's Chromium pipe transport hangs under bun):
//   node test/e2e/browser-wasm.e2e.mjs      (or:  bun run test:e2e)
// The UI server runs as a `bun` subprocess (it needs to load the .ts sources); this
// driver stays pure-node so Playwright launches cleanly.
//
// Prereqs (auto-skips with instructions if missing):
//   bunx playwright install chromium
//   bun run src/index.ts download-model      # ~81MB into .executive/{vendor,models}
//
// It never touches your real .executive: a temp EXECUTIVE_HOME junction-links the
// already-downloaded vendor/ + models/ (read-only reuse).

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dirname, "..", "..");
const WAV = resolve(__dirname, "fixtures", "jfk.wav");
const SRC_VENDOR = resolve(PROJECT, ".executive", "vendor");
const SRC_MODELS = resolve(PROJECT, ".executive", "models");

function skip(msg) { console.log("SKIP: " + msg); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── prerequisites ────────────────────────────────────────────────────────────
let chromium;
try { ({ chromium } = await import("playwright")); }
catch { skip("playwright not installed — run `bunx playwright install chromium`."); }
if (!existsSync(resolve(SRC_VENDOR, "transformers.min.js")) || !existsSync(resolve(SRC_MODELS, "Xenova", "whisper-base", "onnx"))) {
  skip("model not downloaded — run `bun run src/index.ts download-model` first.");
}

// ── isolated temp home that reuses the downloaded assets ─────────────────────
const HOME = mkdtempSync(resolve(tmpdir(), "exec-e2e-"));
const EXEC = resolve(HOME, ".executive");
const PORT = 4318;
const BASE = "http://127.0.0.1:" + PORT + "/";
const EVENTS = resolve(EXEC, "events", "system.jsonl");
const readNotes = () => !existsSync(EVENTS) ? [] : readFileSync(EVENTS, "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e && e.type === "system.note" && e.data && e.data.via === "voice");

// Start the UI server as a bun subprocess (it loads the .ts sources + Bun.serve).
const server = spawn("bun", ["run", "src/index.ts", "ui", "--no-watch", "--port", String(PORT)], {
  cwd: PROJECT, env: { ...process.env, EXECUTIVE_HOME: EXEC }, shell: true, stdio: "ignore",
});

const failures = [];
const check = (name, ok) => { console.log((ok ? "  ✓ " : "  ✗ ") + name); if (!ok) failures.push(name); };
let browser;
try {
  // wait for the server (bootstrap creates EXEC on startup)
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + "api/config"); up = true; break; } catch { await sleep(500); }
  }
  if (!up) throw new Error("server did not start");

  // reuse the big assets + switch to browser-wasm (server reads config per-request)
  symlinkSync(SRC_VENDOR, resolve(EXEC, "vendor"), "junction");
  symlinkSync(SRC_MODELS, resolve(EXEC, "models"), "junction");
  const cfgPath = resolve(EXEC, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.transcribe = { ...cfg.transcribe, mode: "browser-wasm", wasmModel: "Xenova/whisper-base", language: "" };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  browser = await chromium.launch({ headless: true, args: [
    "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
    "--use-file-for-fake-audio-capture=" + WAV, "--autoplay-policy=no-user-gesture-required",
  ]});
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForTimeout(1200);

  check("mode is browser-wasm", await page.evaluate(() => cfgT.mode) === "browser-wasm");
  check("exactly one #lang selector", await page.evaluate(() => document.querySelectorAll("#lang").length) === 1);
  check("no duplicate #setLang selector", await page.evaluate(() => document.querySelectorAll("#setLang").length) === 0);
  check("language options are auto/th/en",
    JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("#lang option")].map((o) => o.value))) === '["","th","en"]');

  await page.selectOption("#lang", "en");
  await page.evaluate(() => onLangChange());
  await page.waitForTimeout(600);
  const persisted = (await (await fetch(BASE + "api/config")).json()).transcribe.language;
  check("language change persists to config", persisted === "en");

  const before = readNotes().length;
  console.log("  … recording fake JFK audio + transcribing in-browser (WASM CPU, ~30s on first load)");
  await page.evaluate(() => startListen());
  await page.waitForTimeout(11500);
  await page.evaluate(() => stopListen(true));
  let text = null;
  for (let i = 0; i < 90; i++) { const n = readNotes(); if (n.length > before) { text = n[n.length - 1].data.msg; break; } await page.waitForTimeout(1000); }
  console.log("  transcribed:", JSON.stringify(text));
  check("browser-wasm transcribed the JFK line", !!text && /country/i.test(text));

  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(1000);
  check("selector reflects persisted language after reload", await page.evaluate(() => document.querySelector("#lang").value) === "en");
} finally {
  if (browser) await browser.close();
  try { server.kill(); } catch {}
  try { rmSync(HOME, { recursive: true, force: true }); } catch {}
}

if (failures.length) { console.log("\nFAIL ✗ — failed: " + failures.join(", ")); process.exit(1); }
console.log("\nPASS ✓ — browser-wasm end-to-end + single language selector");
process.exit(0);
