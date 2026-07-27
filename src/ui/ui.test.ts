// Offline tests for the dashboard (Phase 18).
// renderPage is pure; the server is exercised end-to-end over a real localhost port.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { renderPage } from "./page.js";
import { startUiServer } from "./server.js";
import { read } from "../events/store.js";

describe("renderPage", () => {
  it("is a self-contained HTML page with the key sections", () => {
    const html = renderPage();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("ExecutiveOS");
    // "Now" became "Where you are" in Phase 45; the other three headings are unchanged.
    for (const s of ["Where you are", "Recommended action", "Needs you", "Last Autopilot run"]) {
      expect(html).toContain(s);
    }
    // no external resources (self-contained)
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("src=");
  });
});

describe("ui server", () => {
  const DIR = "/tmp/executive-test-ui-" + randomUUID();
  let server: ReturnType<typeof startUiServer> | null = null;

  beforeEach(() => { process.env.EXECUTIVE_HOME = DIR; });
  afterEach(() => {
    if (server) { server.stop(); server = null; }
    try { rmSync(DIR, { recursive: true, force: true }); } catch {}
    delete process.env.EXECUTIVE_HOME;
  });

  it("serves the HTML page at /", async () => {
    server = startUiServer({ port: 0 }); // port 0 = OS-assigned free port
    const res = await fetch("http://127.0.0.1:" + server.port + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("ExecutiveOS");
  });

  it("returns a digest from /api/state", async () => {
    server = startUiServer({ port: 0 });
    const res = await fetch("http://127.0.0.1:" + server.port + "/api/state");
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.digest).toBeDefined();
    expect(j.digest.needsYou).toBeInstanceOf(Array);
    expect(typeof j.summary).toBe("string");
  });

  it("emits an allowed system event via /api/emit and it lands in the log", async () => {
    server = startUiServer({ port: 0 });
    const base = "http://127.0.0.1:" + server.port;
    const res = await fetch(base + "/api/emit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "system.blocked", data: { reason: "waiting on vendor" } }),
    });
    const j = await res.json();
    expect(j.ok).toBe(true);

    const events = await read("system");
    expect(events.some((e) => e.type === "system.blocked" && e.data.reason === "waiting on vendor")).toBe(true);

    // and the digest now surfaces it under needsYou
    const st = await (await fetch(base + "/api/state")).json();
    expect(st.digest.now.blocked).toBe(true);
  });

  it("rejects a non-whitelisted emit type", async () => {
    server = startUiServer({ port: 0 });
    const res = await fetch("http://127.0.0.1:" + server.port + "/api/emit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "git.commit", data: {} }),
    });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.ok).toBe(false);
  });

  it("404s unknown paths", async () => {
    server = startUiServer({ port: 0 });
    const res = await fetch("http://127.0.0.1:" + server.port + "/nope");
    expect(res.status).toBe(404);
  });

  it("serves config at /api/config (transcribe block + presets, but never the key VALUE)", async () => {
    // bootstrap writes a default config with the capture + transcribe blocks
    await (await import("../bootstrap.js")).bootstrap();
    process.env.EXECUTIVE_TRANSCRIBE_KEY = "super-secret-key-value-xyz";
    try {
      server = startUiServer({ port: 0 });
      const j = await (await fetch("http://127.0.0.1:" + server.port + "/api/config")).json();
      expect(j.capture).toBeDefined();
      expect(typeof j.capture.from).toBe("string");
      // the settings editor needs the whole transcribe block (which holds NO secret)…
      expect(j.transcribe.mode).toBe("webspeech");
      expect(j.presets.groq).toBeDefined();
      // …but the actual key value from the env var must never appear in the response.
      expect(JSON.stringify(j)).not.toContain("super-secret-key-value-xyz");
    } finally {
      delete process.env.EXECUTIVE_TRANSCRIBE_KEY;
    }
  });

  it("/api/config exposes the screen block but never the vision key VALUE; /api/settings persists a screen toggle", async () => {
    await (await import("../bootstrap.js")).bootstrap();
    // A vision config that NAMES an env var holding the key — the key value must never surface.
    const { updateScreenConfig } = await import("../config.js");
    updateScreenConfig({ vision: { enabled: true, apiKeyEnv: "EXECUTIVE_WORKER_KEY" } });
    process.env.EXECUTIVE_WORKER_KEY = "vision-secret-key-abc";
    try {
      server = startUiServer({ port: 0 });
      const base = "http://127.0.0.1:" + server.port;
      const j = await (await fetch(base + "/api/config")).json();
      // the screen block IS exposed (settings editor needs it) …
      expect(j.screen.vision.enabled).toBe(true);
      expect(j.screen.vision.apiKeyEnv).toBe("EXECUTIVE_WORKER_KEY");
      // … but the actual key VALUE from the env var must never appear anywhere in the response.
      expect(JSON.stringify(j)).not.toContain("vision-secret-key-abc");

      // toggling OCR via /api/settings persists (a fresh /api/config reflects it).
      const res = await fetch(base + "/api/settings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ screen: { ocr: { enabled: true } } }),
      });
      expect((await res.json()).ok).toBe(true);
      const cfg2 = await (await fetch(base + "/api/config")).json();
      expect(cfg2.screen.ocr.enabled).toBe(true);
      expect(cfg2.screen.vision.enabled).toBe(true); // unchanged by the partial patch
    } finally {
      delete process.env.EXECUTIVE_WORKER_KEY;
    }
  });

  it("/api/autonomy toggles the gates and /api/config reflects them", async () => {
    await (await import("../bootstrap.js")).bootstrap();
    server = startUiServer({ port: 0 });
    const base = "http://127.0.0.1:" + server.port;

    const before = await (await fetch(base + "/api/config")).json();
    expect(before.autonomy.advisorEnabled).toBe(false);

    const res = await fetch(base + "/api/autonomy", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ advisorEnabled: true, inferEnabled: true }),
    });
    expect((await res.json()).ok).toBe(true);

    const after = await (await fetch(base + "/api/config")).json();
    expect(after.autonomy.advisorEnabled).toBe(true);
    expect(after.autonomy.inferEnabled).toBe(true);
    expect(after.autonomy.autopilotEnabled).toBe(false); // untouched by the partial patch
  });

  it("/api/autonomy cannot arm autopilot.apply — repo-writing autonomy stays a file edit", async () => {
    await (await import("../bootstrap.js")).bootstrap();
    server = startUiServer({ port: 0 });
    const base = "http://127.0.0.1:" + server.port;

    const res = await fetch(base + "/api/autonomy", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ autopilotEnabled: true, autopilotApply: true }),
    });
    const j = await res.json();
    expect(j.autonomy.autopilotEnabled).toBe(true);
    expect(j.autonomy.autopilotApply).toBe(false);

    const after = await (await fetch(base + "/api/config")).json();
    expect(after.autonomy.autopilotApply).toBe(false);
  });

  it("/api/transcribe returns a clear error when mode is not whisper-api", async () => {
    await (await import("../bootstrap.js")).bootstrap();
    server = startUiServer({ port: 0 });
    const res = await fetch("http://127.0.0.1:" + server.port + "/api/transcribe", { method: "POST", body: "x" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not configured");
  });

  it("POST /api/settings persists a transcribe mode change", async () => {
    await (await import("../bootstrap.js")).bootstrap();
    server = startUiServer({ port: 0 });
    const base = "http://127.0.0.1:" + server.port;
    const res = await fetch(base + "/api/settings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcribe: { mode: "whisper-api", baseUrl: "http://127.0.0.1:8000", model: "whisper-1" } }),
    });
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.transcribe.mode).toBe("whisper-api");
    // and it persisted — a fresh /api/config reflects it
    const cfg = await (await fetch(base + "/api/config")).json();
    expect(cfg.transcribe.mode).toBe("whisper-api");
    expect(cfg.transcribe.baseUrl).toBe("http://127.0.0.1:8000");
  });

  it("POST /api/settings rejects an invalid mode", async () => {
    await (await import("../bootstrap.js")).bootstrap();
    server = startUiServer({ port: 0 });
    const res = await fetch("http://127.0.0.1:" + server.port + "/api/settings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcribe: { mode: "bogus" } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it("static asset serving 404s when absent and rejects path escape", async () => {
    await (await import("../bootstrap.js")).bootstrap();
    server = startUiServer({ port: 0 });
    const base = "http://127.0.0.1:" + server.port;
    const missing = await fetch(base + "/vendor/transformers.min.js");
    expect(missing.status).toBe(404);
    // a ..-escape must never return the escaped file's contents
    const escape = await fetch(base + "/vendor/..%2f..%2fconfig.json");
    expect(escape.status).not.toBe(200);
  });

  it("accepts a dictated note (system.note) via /api/emit", async () => {
    server = startUiServer({ port: 0 });
    const base = "http://127.0.0.1:" + server.port;
    const res = await fetch(base + "/api/emit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "system.note", data: { msg: "blocked on the webhook", via: "voice" } }),
    });
    expect((await res.json()).ok).toBe(true);
    const events = await read("system");
    expect(events.some((e) => e.type === "system.note" && e.data.msg === "blocked on the webhook")).toBe(true);
  });

  it("download returns immediately and reports running", async () => {
    await (await import("../bootstrap.js")).bootstrap();
    server = startUiServer({ port: 0 });
    const base = "http://127.0.0.1:" + server.port;
    const t0 = Date.now();
    const res = await fetch(base + "/api/transcribe/download", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "definitely-not-a-real-model/xxx" }),
    });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(202);
    const j = await res.json();
    expect(j.started).toBe(true);
    expect(j.running).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it("status exposes the download block", async () => {
    await (await import("../bootstrap.js")).bootstrap();
    server = startUiServer({ port: 0 });
    const base = "http://127.0.0.1:" + server.port;
    const res = await fetch(base + "/api/transcribe/status");
    const s = await res.json();
    expect(s.libReady).toBeDefined();
    expect(s.modelReady).toBeDefined();
    expect(s.download).toBeDefined();
    expect(typeof s.download.running).toBe("boolean");
  });
});

describe("renderPage — listening UI", () => {
  it("includes the listening card + speech wiring + proposals", () => {
    const html = renderPage();
    expect(html).toContain("Listening");
    expect(html).toContain("SpeechRecognition");
    expect(html).toContain("Decisions for you");
    expect(html).toContain("toggleListen");
  });
});

// ── Phase 35: the chat routes ───────────────────────────────────────────────

describe("chat routes", () => {
  const DIR = "/tmp/executive-test-chat-" + randomUUID();
  let server: ReturnType<typeof startUiServer> | null = null;

  beforeEach(() => { process.env.EXECUTIVE_HOME = DIR; });
  afterEach(() => {
    if (server) { server.stop(); server = null; }
    try { rmSync(DIR, { recursive: true, force: true }); } catch {}
    delete process.env.EXECUTIVE_HOME;
  });

  async function enableAgent(): Promise<void> {
    await (await import("../bootstrap.js")).bootstrap();
    const { updateAutonomyConfig } = await import("../config.js");
    updateAutonomyConfig({ agentEnabled: true });
  }

  it("refuses every chat route while the agent is off", async () => {
    await (await import("../bootstrap.js")).bootstrap();
    server = startUiServer({ port: 0 });
    const base = "http://127.0.0.1:" + server.port;

    expect((await fetch(base + "/api/chat/history")).status).toBe(403);
    const post = await fetch(base + "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(post.status).toBe(403);
  });

  it("serves history and reports the agent state through /api/config", async () => {
    await enableAgent();
    server = startUiServer({ port: 0 });
    const base = "http://127.0.0.1:" + server.port;

    const cfg = await (await fetch(base + "/api/config")).json();
    expect(cfg.agent.enabled).toBe(true);
    expect(cfg.autonomy.agentEnabled).toBe(true);

    const hist = await (await fetch(base + "/api/chat/history")).json();
    expect(hist.messages).toEqual([]);
    expect(hist.pending).toBeNull();
  });

  it("rejects an empty message and a malformed confirm", async () => {
    await enableAgent();
    server = startUiServer({ port: 0 });
    const base = "http://127.0.0.1:" + server.port;

    const empty = await fetch(base + "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    expect(empty.status).toBe(400);

    const bad = await fetch(base + "/api/chat/confirm", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pendingId: "x", decision: "maybe" }),
    });
    expect(bad.status).toBe(400);
  });

  it("clearing an empty conversation is a no-op, not an error", async () => {
    await enableAgent();
    server = startUiServer({ port: 0 });
    const j = await (await fetch("http://127.0.0.1:" + server.port + "/api/chat/clear", { method: "POST" })).json();
    expect(j.ok).toBe(true);
    expect(j.archived).toBeNull();
  });
});

describe("renderPage — chat UI", () => {
  it("includes the chat panel, the confirm chip and the speak toggle", () => {
    const html = renderPage();
    expect(html).toContain("คุยกับผม");
    expect(html).toContain("sendChat");
    expect(html).toContain("confirmChat");
    expect(html).toContain("speechSynthesis");
    // dictation is routed through one function so voice reaches the agent when it is on
    expect(html).toContain("heardVoice");
  });
});

// ── Phase 45: dashboard information architecture ────────────────────────────
// The layout claims (heights, fold, overflow) can only be verified in a real browser —
// that is test/e2e/dashboard-ia.e2e.mjs. These are the guardrails and the structure that
// a unit test CAN see, so a regression here fails without needing Playwright.

describe("renderPage — Phase 45 information architecture", () => {
  const html = renderPage();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const body = html.match(/<main>([\s\S]*?)<\/main>/)?.[1] ?? "";

  it("keeps every card that existed before, and names the four that were anonymous (criterion 14)", () => {
    for (const id of [
      "chatCard", "listenCard", "settingsCard", "autonomyCard", "fileOutputCard",
      "proposalsCard", "suggestCard",              // existed before Phase 45
      "statusCard", "answerCard", "tellCard", "autopilotCard", // gained ids
    ]) {
      expect(body).toContain('id="' + id + '"');
    }
  });

  it("orders the answer before the queue and the configuration (criterion 1/2)", () => {
    const at = (id: string) => body.indexOf('id="' + id + '"');
    expect(at("statusCard")).toBeLessThan(at("answerCard"));
    expect(at("answerCard")).toBeLessThan(at("chatCard"));
    expect(at("chatCard")).toBeLessThan(at("proposalsCard"));
    // every configuration card comes after the queue
    for (const id of ["listenCard", "autonomyCard", "fileOutputCard", "settingsCard"]) {
      expect(at("proposalsCard")).toBeLessThan(at(id));
    }
  });

  it("merges Needs you / Recommended / Suggestions into one card with a one-line empty state (criterion 5)", () => {
    const answer = body.slice(body.indexOf('id="answerCard"'), body.indexOf('id="chatCard"'));
    expect(answer).toContain('id="needsBlock"');
    expect(answer).toContain('id="recBlock"');
    expect(answer).toContain('id="suggestCard"');
    expect(answer).toContain("Nothing needs you right now.");
    // the heading itself is hidden when there is nothing to say, or the card cannot fit 56px
    expect(script).toContain('$("answerHeading").style.display');
  });

  it("bounds the proposal queue at 3 with an expand control (criterion 4)", () => {
    expect(script).toContain("const VISIBLE_PROPOSALS = 3;");
    expect(script).toContain("more proposals");
    expect(script).toContain("function expandProposals()");
    // the bound is on COUNT, not detail: a visible proposal keeps its evidence line
    expect(script).toContain("because:");
  });

  it("collapses the three configuration cards by default, each reporting its state (criterion 3)", () => {
    for (const id of ["listenBody", "autonomyBody", "fileOutputBody", "settingsBody"]) {
      const at = body.indexOf('id="' + id + '"');
      expect(at).toBeGreaterThan(-1);
      expect(body.slice(at, at + 60)).toContain('style="display:none"');
    }
    for (const id of ["listenSummary", "autonomySummary", "foSummary", "settingsSummary"]) {
      expect(body).toContain('id="' + id + '"');
    }
  });

  it("keeps the 🔴 listening indicator OUTSIDE the collapsible body (criterion 9, guardrail 1)", () => {
    const live = body.indexOf('id="listenLive"');
    const bodyStart = body.indexOf('id="listenBody"');
    expect(live).toBeGreaterThan(-1);
    expect(bodyStart).toBeGreaterThan(-1);
    expect(live).toBeLessThan(bodyStart);           // header, not body
    expect(body.slice(live, bodyStart)).toContain("🔴 Listening…");
    // and the card force-opens while the mic is live, so the full status is never hidden
    expect(script).toContain('openCard("listenBody"');
  });

  it("still offers no way to arm autopilot.apply, while reporting it (criterion 10, guardrail 2)", () => {
    // NOTE: the scope said "the string autopilotApply is absent". That was wrong — Phase 34
    // deliberately REPORTS the flag. What must be absent is any way to SET it: no input, and
    // no such key in the patch sent to /api/autonomy.
    expect(body).not.toContain('id="autoAutopilotApply"');
    expect(script).not.toContain("autopilotApply:");
    expect(script).toContain("a.autopilotApply");   // still reported, per Phase 34
  });

  it("declares the two width breakpoints, with minmax(0) so a long path cannot overflow (criterion 7/8)", () => {
    const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(css).toContain("@media (min-width:1180px)");
    expect(css).toContain("@media (max-width:480px)");
    expect(css).toContain("grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)");
    expect(css).toContain(".col { display:grid");
    expect(css).toContain("min-width:0");
  });

  it("emits an inline script that parses — the GOTCHA §8 backslash guard (criterion 12)", () => {
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
  });
});
