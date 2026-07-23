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
    for (const s of ["Now", "Recommended action", "Needs you", "Last Autopilot run"]) {
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
