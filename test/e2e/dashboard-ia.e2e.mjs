// End-to-end measurement of the dashboard's information architecture (Phase 45).
//
// This is the ONLY thing that can verify a layout claim. `bun test` can assert that the
// markup and the CSS exist; it cannot tell you that the answer is above the fold, that the
// proposal queue stopped being 43% of the page, or that nothing scrolls sideways at 420px.
// Every number below was measured on the owner's real dashboard before the change and is
// asserted here after it — so a regression is a failing test, not a re-derivation.
//
// Run with node (NOT bun — Playwright's Chromium pipe transport hangs under bun):
//   node test/e2e/dashboard-ia.e2e.mjs      (or:  bun run test:e2e:ia)
// The UI server runs as a `bun` subprocess (it loads the .ts sources); this driver stays
// pure-node so Playwright launches cleanly.
//
// Prereq (auto-skips with instructions if missing):
//   bunx playwright install chromium
//
// It never touches your real .executive: a temp EXECUTIVE_HOME is used and removed.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const HOME = mkdtempSync(resolve(tmpdir(), "exec-ia-e2e-"));
const EXEC = resolve(HOME, ".executive");
const PORT = 4321;
const BASE = "http://127.0.0.1:" + PORT + "/";

mkdirSync(EXEC, { recursive: true });
// Agent on, so the chat card is VISIBLE — measuring the fold with it hidden would be
// measuring a page the owner does not have.
writeFileSync(resolve(EXEC, "config.json"), JSON.stringify({ agent: { enabled: true } }, null, 2));

// Eight pending proposals — the exact count that made proposalsCard 2,039px (43%).
// Realistic lengths: a short title is not a fair test of a card built to hold evidence.
const PROPOSAL_COUNT = 8;
const items = [];
for (let i = 1; i <= PROPOSAL_COUNT; i++) {
  items.push({
    id: "p" + i,
    createdAt: new Date().toISOString(),
    category: i % 2 ? "work" : "health",
    title: "Proposal number " + i + " with a realistically long title",
    detail: "A couple of sentences of detail, the length the Advisor actually produces, "
      + "so the measured card height means something rather than flattering the bound.",
    evidence: "editsSinceLastCommit is " + (i * 7) + " and currentFile is src/ui/page.ts",
    action: "Do the thing described above, number " + i,
    status: "pending",
    executable: false,
  });
}
writeFileSync(resolve(EXEC, "advisor.json"), JSON.stringify({ items }, null, 2));

// ── start the UI server as a bun subprocess ──────────────────────────────────
// PRE-FLIGHT (learned the hard way): a leftover server from an earlier run keeps the
// port, the new one silently fails to bind, and the browser measures the OLD code
// against a DELETED temp home. That looks like a passing sabotage. Refuse to guess.
let squatter = false;
try { await fetch(BASE + "api/config", { signal: AbortSignal.timeout(1500) }); squatter = true; } catch {}
if (squatter) {
  console.log("ABORT: something is already listening on " + PORT + " — a leftover run from a previous");
  console.log("       invocation. Kill it first, or this test measures the wrong process.");
  rmSync(HOME, { recursive: true, force: true });
  process.exit(1);
}

const server = spawn("bun", ["run", "src/index.ts", "ui", "--no-watch", "--port", String(PORT)], {
  cwd: PROJECT, env: { ...process.env, EXECUTIVE_HOME: EXEC }, stdio: "ignore",
});
// `kill()` on Windows does not reap the child tree; a survivor becomes the squatter above.
function killServer() {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else server.kill();
  } catch { /* best effort */ }
}

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail === undefined ? "" : "  [" + detail + "]"));
  if (!ok) failures.push(name);
}

let browser;
try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + "api/config"); up = true; break; } catch { await sleep(500); }
  }
  if (!up) throw new Error("server did not start");

  // …and prove the server we reached is serving OUR temp home, not a survivor.
  const seeded = await (await fetch(BASE + "api/proposals")).json();
  if ((seeded.proposals || []).length !== PROPOSAL_COUNT) {
    throw new Error("the server on " + PORT + " is not ours — it reports "
      + (seeded.proposals || []).length + " proposals, expected " + PROPOSAL_COUNT);
  }

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 864 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => { console.log("  [pageerror]", e.message); failures.push("page JS error: " + e.message); });
  await p.goto(BASE, { waitUntil: "load" });
  await p.waitForTimeout(1500);   // let refresh() + loadProposals() land

  const box = (id) => p.evaluate((i) => {
    const el = document.getElementById(i);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, left: r.left, height: r.height, width: r.width };
  }, id);
  const pageHeight = () => p.evaluate(() => document.documentElement.scrollHeight);

  // ── 1. the state you are in is at the TOP (was: 3,652px down) ───────────────
  const status = await box("statusCard");
  check("1. statusCard starts above 300px (was 3652)", status && status.top < 300, "top=" + (status && Math.round(status.top)));

  // ── 2. the answer is fully above the fold (was: 4,172px down) ───────────────
  const answer = await box("answerCard");
  check("2. answerCard is fully above the fold at 864px (was 4172)",
    answer && answer.top + answer.height < 864,
    "top=" + (answer && Math.round(answer.top)) + " h=" + (answer && Math.round(answer.height)));

  // ── 5. an empty answer costs one line, not three cards ──────────────────────
  // Measured here, before anything is blocked: needsYou/recommended/suggestions are all empty.
  const emptyState = await p.evaluate(() => ({
    empty: document.getElementById("answerEmpty").style.display !== "none",
    bodyHidden: document.getElementById("answerBody").style.display === "none",
  }));
  check("5a. with nothing pending the card shows the single-line empty state",
    emptyState.empty && emptyState.bodyHidden);
  check("5b. the empty answerCard is <= 56px tall (was ~184px across three cards)",
    answer && answer.height <= 56, "h=" + (answer && Math.round(answer.height)));

  // ── 4. the proposal queue is bounded (was 2,039px = 43% of the page) ────────
  const props = await box("proposalsCard");
  const shown = () => p.evaluate(() => document.querySelectorAll("#proposals .prop").length);
  const moreLabel = await p.evaluate(() => {
    const b = [...document.querySelectorAll("#proposals button")].find((x) => x.textContent.includes("more proposals"));
    return b ? b.textContent.trim() : "";
  });
  check("4a. proposalsCard is under 900px with 8 pending (was 2039)",
    props && props.height < 900, "h=" + (props && Math.round(props.height)));
  check("4b. only 3 proposals are rendered", (await shown()) === 3, "rendered=" + (await shown()));
  check("4c. it offers '+ 5 more proposals'", moreLabel === "+ 5 more proposals", moreLabel);

  // ── 3. the whole page fits in well under half its old height ───────────────
  const h0 = await pageHeight();
  check("3. total page height is under 2400px (was 4766)", h0 < 2400, "h=" + h0);

  // ── 4d. expanding renders all 8, in place, without a fetch ─────────────────
  await p.evaluate(() => {
    const b = [...document.querySelectorAll("#proposals button")].find((x) => x.textContent.includes("more proposals"));
    b.click();
  });
  await p.waitForTimeout(600);
  const afterExpand = await shown();
  check("4d. clicking it renders all 8", afterExpand === PROPOSAL_COUNT, "rendered=" + afterExpand);

  // ── 6. a real item in the queue is shown in full, never truncated ──────────
  const REASON = "waiting on the vendor sandbox key before the migration can be tested";
  await fetch(BASE + "api/emit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "system.blocked", data: { reason: REASON } }),
  });
  await p.evaluate(() => refresh());
  await p.waitForTimeout(800);
  const needs = await p.evaluate(() => {
    const ul = document.getElementById("needs");
    return { count: ul.children.length, text: ul.textContent, visible: document.getElementById("needsBlock").style.display !== "none" };
  });
  check("6a. a blocked state produces a visible Needs-you item", needs.visible && needs.count >= 1, "n=" + needs.count);
  check("6b. the item's full text is present, not truncated", needs.text.includes(REASON));
  const answerNow = await box("answerCard");
  check("6c. the answer card is still fully above the fold with content",
    answerNow && answerNow.top + answerNow.height < 864,
    "top=" + (answerNow && Math.round(answerNow.top)) + " h=" + (answerNow && Math.round(answerNow.height)));

  // ── 7. no horizontal overflow on a narrow screen (was 457px at a 420px viewport) ──
  // An UNBREAKABLE string is planted first. A file path is not one: browsers happily
  // break after "/" and "-", so a realistic-looking path proved nothing here — with it,
  // this check stayed green even with BOTH containment layers deleted. A run of letters
  // with no break opportunity is what makes min-width:0 / overflow-wrap load-bearing.
  await p.setViewportSize({ width: 420, height: 900 });
  await p.evaluate(() => {
    const unbreakable = "averylongunbrokenidentifierwithnoseparatorsatall".repeat(3);
    document.getElementById("now").innerHTML =
      '<div class="row"><span class="k">Current file</span><span class="v">' + unbreakable + "</span></div>";
  });
  await p.waitForTimeout(300);
  const narrow = await p.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  check("7. nothing scrolls sideways at 420px, even with a long path (was 457)",
    narrow.scrollWidth <= 420, "scrollWidth=" + narrow.scrollWidth + " viewport=" + narrow.inner);

  // ── 8. two columns on a wide screen ────────────────────────────────────────
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.waitForTimeout(300);
  const s2 = await box("statusCard"), q2 = await box("proposalsCard");
  check("8. at 1280px the answer and the queue are side by side",
    s2 && q2 && Math.round(s2.left) !== Math.round(q2.left),
    "statusCard.left=" + (s2 && Math.round(s2.left)) + " proposalsCard.left=" + (q2 && Math.round(q2.left)));

  // The two-column track must not widen to fit content either — minmax(0,…) exists for
  // exactly this, and the claim is worthless unless something measures it.
  await p.evaluate(() => {
    const t = document.querySelector("#proposals .prop .title");
    if (t) t.textContent = "averylongunbrokenproposaltitlewithnoseparators".repeat(3);
  });
  await p.waitForTimeout(300);
  const wide = await p.evaluate(() => document.documentElement.scrollWidth);
  check("8b. an unbreakable token in a proposal does not widen the wide layout",
    wide <= 1280, "scrollWidth=" + wide);

  // ── guardrail: the listening indicator is reachable without expanding ──────
  const live = await p.evaluate(() => {
    const el = document.getElementById("listenLive");
    const bodyEl = document.getElementById("listenBody");
    return { exists: !!el, insideBody: !!(el && bodyEl && bodyEl.contains(el)), bodyCollapsed: bodyEl.style.display === "none" };
  });
  check("9. the 🔴 indicator lives outside the collapsible listening body",
    live.exists && !live.insideBody && live.bodyCollapsed);
} finally {
  if (browser) await browser.close();
  killServer();
  await sleep(700);   // let the port actually free before the next invocation
  try { rmSync(HOME, { recursive: true, force: true }); } catch {}
}

if (failures.length) { console.log("\nFAIL ✗ — failed: " + failures.join(", ")); process.exit(1); }
console.log("\nPASS ✓ — dashboard information architecture (Phase 45)");
process.exit(0);
