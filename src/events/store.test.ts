// Unit tests for EventStore (append, read, tail) and bootstrap.
// Uses EXECUTIVE_HOME to isolate tests in a temp directory.

import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { bootstrap } from "../bootstrap.js";
import { loadConfig, defaultConfig } from "../config.js";
import { append, read, tail } from "./store.js";
import { eventLogPath, execRoot, configPath } from "../paths.js";
import type { EventSource } from "./types.js";

// Use a unique temp dir per test run.
const TEST_DIR = "/tmp/executive-test-" + randomUUID();

function setExecutiveHome(dir: string): void {
  process.env.EXECUTIVE_HOME = dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
  delete process.env.EXECUTIVE_HOME;
}

describe("bootstrap()", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("creates the full dir tree + 4 jsonl files + config.json", async () => {
    await bootstrap();

    const { existsSync } = await import("node:fs");
    const root = execRoot();
    expect(existsSync(root)).toBe(true);
    expect(existsSync(root + "/events")).toBe(true);
    expect(existsSync(root + "/logs")).toBe(true);

    for (const src of ["git", "terminal", "editor", "system"]) {
      expect(existsSync(root + "/events/" + src + ".jsonl")).toBe(true);
    }
    expect(existsSync(configPath())).toBe(true);
  });

  it("is idempotent — running twice doesn't error or clobber config", async () => {
    await bootstrap();
    const { readFileSync, existsSync } = await import("node:fs");
    const cfgPath = configPath();
    const firstConfig = readFileSync(cfgPath, "utf-8");

    await bootstrap();

    // Config should be unchanged.
    const secondConfig = readFileSync(cfgPath, "utf-8");
    expect(secondConfig).toBe(firstConfig);

    // Events should still exist.
    expect(existsSync(cfgPath)).toBe(true);
  });
});

describe("append()", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("writes a valid event, fills id+ts, returns it", async () => {
    await bootstrap();
    const event = await append({
      source: "system",
      type: "system.note",
      data: { msg: "hello" },
    });

    expect(event.id).toBeDefined();
    expect(event.ts).toBeDefined();
    expect(event.source).toBe("system");
    expect(event.type).toBe("system.note");
    expect(event.data).toEqual({ msg: "hello" });
  });

  it("the file gains exactly one line", async () => {
    await bootstrap();
    await append({ source: "git", type: "git.commit", data: { branch: "main" } });

    const { readFileSync } = await import("node:fs");
    const content = readFileSync(eventLogPath("git"), "utf-8");
    const lines = content.split("\n").filter((l) => l !== undefined && l.trim() !== "");
    expect(lines.length).toBe(1);
  });

  it("throws when type prefix doesn't match source", async () => {
    await bootstrap();
    await expect(
      append({ source: "git", type: "system.note", data: {} })
    ).rejects.toThrow('Invalid type "system.note" for source "git"');
  });
});

describe("read()", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("returns appended events in order", async () => {
    await bootstrap();
    await append({ source: "editor", type: "editor.save", data: { file: "a.ts" } });
    await append({ source: "editor", type: "editor.save", data: { file: "b.ts" } });

    const events = await read("editor");
    expect(events.length).toBe(2);
    expect(events[0]!.data.file).toBe("a.ts");
    expect(events[1]!.data.file).toBe("b.ts");
  });

  it("skips a corrupt line without throwing", async () => {
    await bootstrap();
    const { writeFileSync } = await import("node:fs");
    const path = eventLogPath("terminal");

    // Manually write a bad line, then a good one.
    writeFileSync(path, "NOT VALID JSON\n");
    await append({ source: "terminal", type: "terminal.command", data: { cmd: "ls" } });

    const events = await read("terminal");
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("terminal.command");
  });
});

describe("tail()", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("returns the newest n merged events sorted by ts", async () => {
    await bootstrap();

    // Add events to different sources with distinct data.
    await append({ source: "git", type: "git.commit", data: { sha: "aaa" } });
    await append({ source: "editor", type: "editor.save", data: { file: "x.ts" } });
    await append({ source: "system", type: "system.note", data: { msg: "z" } });

    // Get last 2 across all sources.
    const events = await tail(2);
    expect(events.length).toBe(2);
    // Should be the last two appended (editor + system).
    const types = events.map((e) => e.type);
    expect(types).toContain("editor.save");
    expect(types).toContain("system.note");
  });
});
