// Phase 25 — transcribe config: backward-compat mode derivation + the settings writer.
// Phase 26 — multi-repo watch config.

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

describe("multi-repo watch.repos config", () => {
  beforeEach(() => { process.env.EXECUTIVE_HOME = DIR; });
  afterEach(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} delete process.env.EXECUTIVE_HOME; });

  it("defaultConfig() has no repos key under watch", () => {
    expect(defaultConfig().watch?.repos).toBeUndefined();
  });

  it("a config with no watch.repos key leaves it undefined and keeps git/fs defaults", () => {
    writeConfig({ version: 1, createdAt: "x", timezone: "Asia/Bangkok" });
    const c = loadConfig();
    expect(c.watch!.repos).toBeUndefined();
    expect(c.watch!.git).toEqual(defaultConfig().watch!.git);
    expect(c.watch!.fs).toEqual(defaultConfig().watch!.fs);
  });

  it("a repos entry with only path fills in all defaults", () => {
    writeConfig({
      version: 1, createdAt: "x", timezone: "Asia/Bangkok",
      watch: { git: {}, fs: {}, repos: [{ path: "/home/me/opm" }] },
    });
    const r = loadConfig().watch!.repos![0]!;
    expect(r.name).toBe("opm");
    expect(r.pollMs).toBe(5000);
    expect(r.watchFiles).toBe(true);
    expect(r.filePaths).toEqual(["/home/me/opm/src"]);
    expect(r.fileDebounceMs).toBe(300);
  });

  it("de-duplicates a two-way name collision by suffixing the second entry", () => {
    writeConfig({
      version: 1, createdAt: "x", timezone: "Asia/Bangkok",
      watch: { git: {}, fs: {}, repos: [{ path: "/a/x" }, { path: "/b/x" }] },
    });
    const repos = loadConfig().watch!.repos!;
    expect(repos[0]!.name).toBe("x");
    expect(repos[1]!.name).toBe("x (2)");
  });

  it("de-duplicates a three-way name collision as (2), (3) in array order", () => {
    writeConfig({
      version: 1, createdAt: "x", timezone: "Asia/Bangkok",
      watch: { git: {}, fs: {}, repos: [{ path: "/a/x" }, { path: "/b/x" }, { path: "/c/x" }] },
    });
    const repos = loadConfig().watch!.repos!;
    expect(repos[0]!.name).toBe("x");
    expect(repos[1]!.name).toBe("x (2)");
    expect(repos[2]!.name).toBe("x (3)");
  });
});
