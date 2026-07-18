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
});
