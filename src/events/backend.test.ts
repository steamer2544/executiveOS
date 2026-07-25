// Shared tests for both JSONL and SQLite backends (Phase 40).
// One test body, run against both backends via config.json.
//
// NOTE on what the parity half can and cannot prove: most cases below assert behaviour
// both backends share, so they would still pass if the "sqlite" label silently ran on
// JSONL (verified — forcing getBackend() to always return JSONL leaves them green). The
// test that anchors the label to reality is "writes to the configured storage medium":
// it asserts the physical artifact. Keep it, or the sqlite half becomes decoration.

import {
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { append, read, tail } from "./store.js";
import { configPath, eventDbPath, eventLogPath } from "../paths.js";
import { clearSqliteCache } from "./backend.js";
import type { EventSource } from "./types.js";

function setExecutiveHome(dir: string): void {
  process.env.EXECUTIVE_HOME = dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  delete process.env.EXECUTIVE_HOME;
}

function writeBackendConfig(dir: string, backend: "jsonl" | "sqlite"): void {
  mkdirSync(dir, { recursive: true });
  const cfg = {
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    timezone: "Asia/Bangkok",
    storage: { backend },
  };
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
}

// ─── Shared test body ───────────────────────────────────────────────────────

function runTests(backend: "jsonl" | "sqlite"): void {
  const label = `backend="${backend}"`;

  describe(`Backend parity — ${label}`, () => {
    // Each test gets its own unique temp dir so sqlite DB files don't collide.
    let dir = "";
    beforeEach(() => {
      dir = "/tmp/executive-test-backend-" + randomUUID();
      setExecutiveHome(dir);
      clearSqliteCache();
      writeBackendConfig(dir, backend);
    });
    afterEach(() => cleanup(dir));

    // Criterion 1: Round-trip
    it("round-trip: append 3 events across 2 sources, read returns them intact", async () => {
      const e1 = await append({
        source: "git",
        type: "git.commit",
        data: { sha: "abc123", msg: "initial" },
      });
      const e2 = await append({
        source: "git",
        type: "git.branch_switch",
        data: { to: "main" },
      });
      const e3 = await append({
        source: "system",
        type: "system.note",
        data: { msg: "ติดอยู่ รอ API key จากทีมการเงิน", n: 3 },
      });

      const gitEvents = await read("git");
      expect(gitEvents.length).toBe(2);
      expect(gitEvents[0]!.seq).toBe(e1.seq);
      expect(gitEvents[0]!.id).toBe(e1.id);
      expect(gitEvents[0]!.source).toBe("git");
      expect(gitEvents[0]!.type).toBe("git.commit");
      expect(gitEvents[0]!.data).toEqual({ sha: "abc123", msg: "initial" });

      const sysEvents = await read("system");
      expect(sysEvents.length).toBe(1);
      expect(sysEvents[0]!.seq).toBe(e3.seq);
      expect(sysEvents[0]!.data).toEqual({
        msg: "ติดอยู่ รอ API key จากทีมการเงิน",
        n: 3,
      });
    });

    // The anchor test: proves the configured backend is the one actually storing
    // events, not just that some backend behaves correctly. Without this, every
    // other case in the sqlite half passes on the JSONL backend.
    it("writes to the configured storage medium", async () => {
      await append({ source: "git", type: "git.commit", data: { sha: "anchor" } });

      const logPath = eventLogPath("git");
      const jsonlContent = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";

      if (backend === "sqlite") {
        expect(existsSync(eventDbPath())).toBe(true);
        // Nothing may reach the JSONL log.
        expect(jsonlContent).toBe("");
      } else {
        expect(existsSync(eventDbPath())).toBe(false);
        expect(jsonlContent).toContain('"sha":"anchor"');
      }
    });

    // Criterion 2: read of empty source → []
    it("read of unknown/empty source returns []", async () => {
      const result = await read("terminal");
      expect(result).toEqual([]);
    });

    // Criterion 3: tail(n, source) returns last n, seq ascending
    it("tail(n, source) returns last n events seq ascending", async () => {
      await append({ source: "git", type: "git.commit", data: { sha: "a" } });
      await append({ source: "git", type: "git.commit", data: { sha: "b" } });
      await append({ source: "git", type: "git.commit", data: { sha: "c" } });

      const last2 = await tail(2, "git");
      expect(last2.length).toBe(2);
      expect(last2[1]!.seq).toBeGreaterThan(last2[0]!.seq);
    });

    // Criterion 4: tail(n) with no source merges all sources, seq ascending
    it("tail(n) without source merges all sources seq ascending", async () => {
      const e1 = await append({ source: "git", type: "git.commit", data: { sha: "a" } });
      const e2 = await append({ source: "system", type: "system.note", data: { x: 1 } });
      const e3 = await append({ source: "screen", type: "screen.capture", data: { x: 2 } });
      const e4 = await append({ source: "git", type: "git.commit", data: { sha: "b" } });
      const e5 = await append({ source: "system", type: "system.note", data: { x: 3 } });

      const merged = await tail(3);
      expect(merged.length).toBe(3);
      expect(merged[0]!.seq).toBe(e3.seq);
      expect(merged[1]!.seq).toBe(e4.seq);
      expect(merged[2]!.seq).toBe(e5.seq);
      for (let i = 1; i < merged.length; i++) {
        expect(merged[i]!.seq).toBeGreaterThan(merged[i - 1]!.seq);
      }
    });

    // Criterion 5: tail(n) where n > total returns everything
    it("tail(n) where n > total returns all events", async () => {
      await append({ source: "git", type: "git.commit", data: { sha: "a" } });
      await append({ source: "system", type: "system.note", data: { x: 1 } });

      const all = await tail(100);
      expect(all.length).toBe(2);
    });

    // Criterion 6: replaceAll
    it("replaceAll leaves target source with subset, other sources untouched", async () => {
      await append({ source: "git", type: "git.commit", data: { sha: "a" } });
      await append({ source: "git", type: "git.commit", data: { sha: "b" } });
      await append({ source: "system", type: "system.note", data: { x: 1 } });

      const gitBefore = await read("git");
      const sysBefore = await read("system");

      const { getBackend } = await import("./backend.js");
      const backend = getBackend();
      backend.replaceAll("git", [gitBefore[0]!]);

      const gitAfter = await read("git");
      expect(gitAfter.length).toBe(1);
      expect(gitAfter[0]!.seq).toBe(gitBefore[0]!.seq);

      const sysAfter = await read("system");
      expect(sysAfter.length).toBe(sysBefore.length);
    });

    // Criterion 7: Corrupt record tolerance
    it("corrupt record tolerance", async () => {
      if (backend === "jsonl") {
        const logPath = eventLogPath("git");
        const e1 = await append({ source: "git", type: "git.commit", data: { sha: "a" } });
        // Inject corrupt line
        writeFileSync(logPath, readFileSync(logPath, "utf-8") + "THIS IS NOT JSON\n");
        const e3 = await append({ source: "git", type: "git.commit", data: { sha: "b" } });

        const events = await read("git");
        expect(events.length).toBe(2);
        expect(events[0]!.seq).toBe(e1.seq);
        expect(events[1]!.seq).toBe(e3.seq);
      } else {
        // SQLite: insert a row with invalid JSON in data column, then read back.
        const { getBackend } = await import("./backend.js");
        const b = getBackend();
        // Seed a valid event first
        await append({ source: "git", type: "git.commit", data: { sha: "a" } });
        // Inject corrupt row via raw bun:sqlite
        const { Database } = await import("bun:sqlite");
        const db = new Database(eventDbPath());
        const stmt = db.prepare(
          "INSERT INTO events (seq, id, ts, source, type, data) VALUES (?, ?, ?, ?, ?, ?)",
        );
        stmt.run(999, "corrupt-id", "2026-01-01T00:00:00.000Z", "git", "git.commit", "NOT VALID JSON");
        db.close();

        const events = await read("git");
        expect(events.length).toBe(2); // corrupt row returns data: {}
        expect(events[0]!.seq).toBe(1);
        expect(events[1]!.seq).toBe(999);
        expect(events[1]!.data).toEqual({});
      }
    });

    // Criterion 8: append validation unchanged
    it("append validation rejects invalid type", async () => {
      await expect(
        append({ source: "git", type: "system.task" })
      ).rejects.toThrow('Invalid type "system.task" for source "git"');
    });
  });

  describe(`Config gate — ${label}`, () => {
    let dir = "";
    beforeEach(() => {
      dir = "/tmp/executive-test-backend-" + randomUUID();
      setExecutiveHome(dir);
      clearSqliteCache();
      writeBackendConfig(dir, backend);
    });
    afterEach(() => cleanup(dir));

    // Criterion 9: no storage block → jsonl, no events.db
    if (backend === "jsonl") {
      it("no storage block → jsonl backend, no events.db created", async () => {
        const cfg = {
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          timezone: "Asia/Bangkok",
        };
        writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");

        await append({ source: "git", type: "git.commit", data: { sha: "a" } });

        const logPath = eventLogPath("git");
        expect(existsSync(logPath)).toBe(true);

        const dbPath = eventDbPath();
        expect(existsSync(dbPath)).toBe(false);
      });
    }

    // Criterion 10: sqlite backend writes to DB, not JSONL
    if (backend === "sqlite") {
      it("sqlite backend writes to events.db, not JSONL", async () => {
        await append({ source: "git", type: "git.commit", data: { sha: "a" } });

        const dbPath = eventDbPath();
        expect(existsSync(dbPath)).toBe(true);

        const logPath = eventLogPath("git");
        if (existsSync(logPath)) {
          const content = readFileSync(logPath, "utf-8");
          expect(content).toBe("");
        }
      });
    }
  });
}

// ─── Run tests for both backends ─────────────────────────────────────────────

for (const backend of ["jsonl", "sqlite"] as const) {
  runTests(backend);
}

// ─── Criterion 11: an invalid backend value must degrade, never brick ────────

describe("Config gate — invalid storage.backend", () => {
  let dir = "";
  beforeEach(() => {
    dir = "/tmp/executive-test-backend-" + randomUUID();
    setExecutiveHome(dir);
    clearSqliteCache();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify(
        {
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          timezone: "Asia/Bangkok",
          storage: { backend: "postgres" },
        },
        null,
        2
      ) + "\n"
    );
  });
  afterEach(() => cleanup(dir));

  it("falls back to jsonl, warns on stderr, and never throws", async () => {
    const original = process.stderr.write.bind(process.stderr);
    const warnings: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const { loadConfig } = await import("../config.js");
      expect(loadConfig().storage?.backend).toBe("jsonl");

      // And the events actually land in the JSONL log, not a database.
      await append({ source: "git", type: "git.commit", data: { sha: "a" } });
      expect(existsSync(eventDbPath())).toBe(false);
      expect(readFileSync(eventLogPath("git"), "utf-8")).toContain('"sha":"a"');
    } finally {
      process.stderr.write = original;
    }

    expect(warnings.join("")).toContain("storage.backend");
  });
});
