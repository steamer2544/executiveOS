// End-to-end test for the chat UI (Phase 37 fixes): markdown rendering + the
// no-yank scroll behaviour. Runs a REAL headless Chromium (Playwright) against the
// dashboard, seeding conversation.jsonl DIRECTLY so nothing here calls the LLM
// gateway — the two things under test are pure browser rendering, not the agent.
//
// Run with node (NOT bun — Playwright's Chromium pipe transport hangs under bun):
//   node test/e2e/chat-ui.e2e.mjs      (or:  bun run test:e2e:chat)
// The UI server runs as a `bun` subprocess (it loads the .ts sources); this driver
// stays pure-node so Playwright launches cleanly.
//
// Prereq (auto-skips with instructions if missing):
//   bunx playwright install chromium
//
// It never touches your real .executive: a temp EXECUTIVE_HOME is used and removed.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dirname, "..", "..");

function skip(msg) { console.log("SKIP: " + msg); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chromium;
try { ({ chromium } = await import("playwright")); }
catch { skip("playwright not installed — run `bunx playwright install chromium`."); }

// ── isolated temp home ────────────────────────────────────────────────────────
const HOME = mkdtempSync(resolve(tmpdir(), "exec-chat-e2e-"));
const EXEC = resolve(HOME, ".executive");
const PORT = 4319;
const BASE = "http://127.0.0.1:" + PORT + "/";
const CONV = resolve(EXEC, "conversation.jsonl");

// Pre-create the home + config with the agent ON, so the chat card shows without a
// restart. bootstrap is idempotent and will NOT overwrite an existing config.json;
// loadConfig() fills every other field with defaults.
mkdirSync(EXEC, { recursive: true });
writeFileSync(resolve(EXEC, "config.json"), JSON.stringify({ agent: { enabled: true } }, null, 2));

const now = () => new Date().toISOString();
let seq = 0;
function seed(msg) { appendFileSync(CONV, JSON.stringify({ id: "seed-" + seq++, ts: now(), ...msg }) + "\n"); }

// A user message whose literal ** must survive (users are not markdown-rendered).
seed({ role: "user", text: "ผู้ใช้พิมพ์ **ดาว** ไว้ ห้ามแปลง" });
// Filler to make the chat log overflow its 340px box (so scrolling is real).
for (let i = 1; i <= 24; i++) {
  seed({ role: "user", text: "คำถามที่ " + i });
  seed({ role: "assistant", text: "ตอบข้อ " + i });
}
// The markdown showcase — the last assistant message.
const MD = [
  "# หัวข้อทดสอบ",
  "นี่คือ **ตัวหนา** และ `inline code` กับ [ลิงก์](https://example.com)",
  "- ข้อหนึ่ง",
  "- ข้อสอง",
  "```",
  "const x = 1;",
  "```",
].join("\n");
seed({ role: "assistant", text: MD });

// ── start the UI server as a bun subprocess ──────────────────────────────────
const server = spawn("bun", ["run", "src/index.ts", "ui", "--no-watch", "--port", String(PORT)], {
  cwd: PROJECT, env: { ...process.env, EXECUTIVE_HOME: EXEC }, shell: true, stdio: "ignore",
});

const failures = [];
const check = (name, ok) => { console.log((ok ? "  ✓ " : "  ✗ ") + name); if (!ok) failures.push(name); };
let browser;
try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + "api/config"); up = true; break; } catch { await sleep(500); }
  }
  if (!up) throw new Error("server did not start");

  const cfg = await (await fetch(BASE + "api/config")).json();
  check("agent is enabled (chat card will show)", cfg.agent && cfg.agent.enabled === true);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newContext();
  const p = await page.newPage();
  p.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForSelector("#chatCard", { state: "visible", timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(1200);

  check("chat card is visible", await p.evaluate(() => {
    const c = document.getElementById("chatCard");
    return !!c && c.style.display !== "none";
  }));

  // ── markdown rendering ──────────────────────────────────────────────────────
  // Locate the assistant bubble carrying the showcase, and the user bubble.
  const md = await p.evaluate(() => {
    const bubbles = [...document.querySelectorAll("#chatLog > div")];
    const asst = bubbles.find((b) => b.textContent.includes("ตัวหนา"));
    const user = bubbles.find((b) => b.textContent.includes("ดาว"));
    return {
      asstHtml: asst ? asst.innerHTML : "",
      userHtml: user ? user.innerHTML : "",
    };
  });
  check("bold renders as <strong>", /<strong>ตัวหนา<\/strong>/.test(md.asstHtml));
  check("inline code renders as <code>", /<code[^>]*>inline code<\/code>/.test(md.asstHtml));
  check("a link renders as <a href=https://…>", /<a href="https:\/\/example\.com"/.test(md.asstHtml));
  check("list items render as <li>", /<li>ข้อหนึ่ง<\/li>/.test(md.asstHtml) && /<li>ข้อสอง<\/li>/.test(md.asstHtml));
  check("a code fence renders as <pre> with the code", /<pre[^>]*>[^]*const x = 1;[^]*<\/pre>/.test(md.asstHtml));
  check("the heading text is present and bold", md.asstHtml.includes("หัวข้อทดสอบ") && /font-weight:700/.test(md.asstHtml));
  check("assistant markdown markers are consumed (no literal **)", !md.asstHtml.includes("**"));
  check("a USER message stays literal (** preserved, not bolded)",
    md.userHtml.includes("**ดาว**") && !/<strong>/.test(md.userHtml));

  // ── scroll behaviour ────────────────────────────────────────────────────────
  const atBottom = () => p.evaluate(() => {
    const l = document.getElementById("chatLog");
    return l.scrollHeight - l.scrollTop - l.clientHeight < 40;
  });
  const isScrollable = await p.evaluate(() => {
    const l = document.getElementById("chatLog");
    return l.scrollHeight > l.clientHeight + 60;
  });
  check("chat log actually overflows (scroll test is meaningful)", isScrollable);
  check("initial load lands at the bottom", await atBottom());

  // THE regression the owner reported: scroll up to read, a refresh must NOT yank down.
  await p.evaluate(() => { document.getElementById("chatLog").scrollTop = 0; });
  const topBefore = await p.evaluate(() => document.getElementById("chatLog").scrollTop);
  // A brand-new assistant message arrives while the owner is reading older ones…
  appendFileSync(CONV, JSON.stringify({ id: "late-1", ts: now(), role: "assistant", text: "ข้อความใหม่ที่เพิ่งเข้ามา 1" }) + "\n");
  await p.evaluate(() => loadChat());   // the 5s refresh tick, invoked directly
  await p.waitForTimeout(400);
  const topAfter = await p.evaluate(() => document.getElementById("chatLog").scrollTop);
  check("scrolled-up position is NOT yanked to the bottom on refresh",
    topAfter <= topBefore + 8 && !(await atBottom()));

  // …but the normal follow-along still works: at the bottom, a new message follows.
  await p.evaluate(() => { const l = document.getElementById("chatLog"); l.scrollTop = l.scrollHeight; });
  appendFileSync(CONV, JSON.stringify({ id: "late-2", ts: now(), role: "assistant", text: "ข้อความใหม่ที่เพิ่งเข้ามา 2" }) + "\n");
  await p.evaluate(() => loadChat());
  await p.waitForTimeout(400);
  check("when already at the bottom, a new message DOES follow down", await atBottom());
} finally {
  if (browser) await browser.close();
  try { server.kill(); } catch {}
  try { rmSync(HOME, { recursive: true, force: true }); } catch {}
}

if (failures.length) { console.log("\nFAIL ✗ — failed: " + failures.join(", ")); process.exit(1); }
console.log("\nPASS ✓ — chat markdown rendering + no-yank scroll");
process.exit(0);
