// Phase 25 — transcribe config: backward-compat mode derivation + the settings writer.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadConfig, updateTranscribeConfig, defaultConfig } from "./config.js";
import { configPath } from "./paths.js";

const DIR = "/tmp/executive-test-config-" + randomUUID();

function writeConfig(obj: unknown): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(obj, null, 2));
}

describe("transcribe config merge", () => {
  beforeEach(() => { process.env.EXECUTIVE_HOME = DIR; });
  afterEach(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} delete process.env.EXECUTIVE_HOME; });

  it("defaults to webspeech when no transcribe block is present (Phase 1 config)", () => {
    writeConfig({ version: 1, createdAt: "x", timezone: "Asia/Bangkok" });
    expect(loadConfig().transcribe!.mode).toBe("webspeech");
  });

  it("derives mode=whisper-api from a legacy Phase-24 enabled:true (no mode field)", () => {
    writeConfig({ version: 1, createdAt: "x", timezone: "Asia/Bangkok", transcribe: { enabled: true } });
    expect(loadConfig().transcribe!.mode).toBe("whisper-api");
  });

  it("an explicit mode always wins over the legacy enabled flag", () => {
    writeConfig({ version: 1, createdAt: "x", timezone: "Asia/Bangkok", transcribe: { enabled: false, mode: "browser-wasm" } });
    expect(loadConfig().transcribe!.mode).toBe("browser-wasm");
  });
});

describe("updateTranscribeConfig", () => {
  beforeEach(() => { process.env.EXECUTIVE_HOME = DIR; writeConfig(defaultConfig()); });
  afterEach(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} delete process.env.EXECUTIVE_HOME; });

  it("persists a whitelisted patch and keeps the legacy enabled flag consistent", () => {
    updateTranscribeConfig({ mode: "whisper-api", baseUrl: "http://127.0.0.1:8000/", model: "whisper-1", language: "" });
    const t = loadConfig().transcribe!;
    expect(t.mode).toBe("whisper-api");
    expect(t.enabled).toBe(true);          // kept consistent for old readers
    expect(t.baseUrl).toBe("http://127.0.0.1:8000/");
    expect(t.language).toBeNull();          // "" normalizes to null (auto)
  });

  it("rejects an invalid mode and writes nothing", () => {
    expect(() => updateTranscribeConfig({ mode: "nope" })).toThrow();
    expect(loadConfig().transcribe!.mode).toBe("webspeech"); // unchanged
  });

  it("ignores non-transcribe keys (only the transcribe block is writable)", () => {
    updateTranscribeConfig({ mode: "browser-wasm", timezone: "Evil/Zone" } as Record<string, unknown>);
    const c = loadConfig();
    expect(c.transcribe!.mode).toBe("browser-wasm");
    expect(c.timezone).toBe("Asia/Bangkok"); // untouched
  });
});
