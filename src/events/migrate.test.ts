// Tests for the migration command (Phase 40, Job 2).
//
// Criteria 16–21 from the spec:
//   16. Dry-run writes nothing.
//   17. Apply migrates everything.
//   18. Idempotent — second run reports alreadyPresent.
//   19. Conflict is reported, not swallowed.
//   20. meta.json is advanced.
//   21. JSONL files are untouched by migration.

import {
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { configPath, eventDbPath, eventLogPath } from "../paths.js";
import { clearSqliteCache } from "./backend.js";
import { append } from "./store.js";
import { migrateEventsToSqlite } from "./migrate.js";
import { currentSeq, nextSeq } from "./seq.js";

function setExecutiveHome(dir: string): void {
  process.env.EXECUTIVE_HOME = dir;
}

function cleanup(dir: string): void {
  try {
    clearSqliteCache();
    // The migration function opens its own DB handle (not the backend's cache).
    // Close it so rmSync can delete the temp dir on Windows.
    const dbPath = dir + "/events.db";
    if (existsSync(dbPath)) {
      try {
        const db = new Database(dbPath);
        db.close();
      } catch {
        /* ignore */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  delete process.env.EXECUTIVE_HOME;
}

function writeJsonlConfig(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const cfg = {
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    timezone: "Asia/Bangkok",
    storage: { backend: "jsonl" },
  };
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
}

// Seed JSONL files with events. Returns the events that were written.
const SOURCES: Array<"git" | "system" | "editor" | "terminal" | "screen"> = [
  "git", "system", "editor", "terminal", "screen",
];

function seedJsonlEvents(dir: string): Array<{ seq: number; id: string }> {
  setExecutiveHome(dir);
  writeJsonlConfig(dir);
  clearSqliteCache();

  // Ensure the events directory exists (writeFileSync with flag: 'a' doesn't create dirs).
  const eventsDirPath = dir + "/events";
  mkdirSync(eventsDirPath, { recursive: true });

  const events: Array<{ seq: number; id: string }> = [];
  for (let i = 0; i < 5; i++) {
    const source = SOURCES[i]!;
    const e = {
      seq: i + 1,
      id: randomUUID(),
      ts: new Date().toISOString(),
      source,
      type: "git.commit",
      data: { sha: `abc${i}` },
    };
    writeFileSync(eventLogPath(source), JSON.stringify(e) + "\n", { flag: "a" });
    events.push({ seq: e.seq, id: e.id });
  }
  return events;
}

// ─── Criterion 16: dry-run writes nothing ────────────────────────────────────

describe("Migration — criterion 16: dry-run writes nothing", () => {
  let dir = "";
  beforeEach(() => {
    dir = "/tmp/executive-test-migrate-" + randomUUID();
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => cleanup(dir));

  it("reports inserted count but DB has 0 rows", () => {
    const seeded = seedJsonlEvents(dir);
    const total = seeded.length;

    const report = migrateEventsToSqlite();

    expect(report.mode).toBe("dry-run");
    expect(report.inserted).toBe(total);
    expect(report.conflicts).toEqual([]);

    // DB must have ZERO rows despite the read count.
    const db = new Database(eventDbPath());
    const count = db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number };
    db.close();
    expect(count.c).toBe(0);
  });
});

// ─── Criterion 17: apply migrates everything ──────────────────────────────────

describe("Migration — criterion 17: apply migrates everything", () => {
  let dir = "";
  beforeEach(() => {
    dir = "/tmp/executive-test-migrate-" + randomUUID();
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => cleanup(dir));

  it("DB row count equals total JSONL events", () => {
    const seeded = seedJsonlEvents(dir);
    const total = seeded.length;

    const report = migrateEventsToSqlite({ apply: true });

    expect(report.mode).toBe("apply");
    expect(report.inserted).toBe(total);
    expect(report.conflicts).toEqual([]);

    const db = new Database(eventDbPath());
    const count = db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number };
    db.close();
    expect(count.c).toBe(total);
  });

  it("sample event fields match deep-equality", () => {
    seedJsonlEvents(dir);

    migrateEventsToSqlite({ apply: true });

    const db = new Database(eventDbPath());
    const row = db.prepare("SELECT * FROM events WHERE seq = 1").get() as Record<string, unknown>;
    db.close();

    expect(row).toMatchObject({
      seq: 1,
      source: "git",
      type: "git.commit",
    });
    expect(typeof row.data).toBe("string");
    const parsed = JSON.parse(row.data as string) as { sha: string };
    expect(parsed.sha).toBe("abc0");
  });
});

// ─── Criterion 18: idempotent ─────────────────────────────────────────────────

describe("Migration — criterion 18: idempotent", () => {
  let dir = "";
  beforeEach(() => {
    dir = "/tmp/executive-test-migrate-" + randomUUID();
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => cleanup(dir));

  it("second run reports alreadyPresent = total, inserted = 0", () => {
    const seeded = seedJsonlEvents(dir);
    const total = seeded.length;

    migrateEventsToSqlite({ apply: true });

    const report2 = migrateEventsToSqlite({ apply: true });

    expect(report2.alreadyPresent).toBe(total);
    expect(report2.inserted).toBe(0);
    expect(report2.conflicts).toEqual([]);

    // Row count unchanged.
    const db = new Database(eventDbPath());
    const count = db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number };
    db.close();
    expect(count.c).toBe(total);
  });
});

// ─── Criterion 19: conflict is reported ───────────────────────────────────────

describe("Migration — criterion 19: conflict is reported", () => {
  let dir = "";
  beforeEach(() => {
    dir = "/tmp/executive-test-migrate-" + randomUUID();
    mkdirSync(dir, { recursive: true });
    mkdirSync(dir + "/events", { recursive: true });
    setExecutiveHome(dir);
    writeJsonlConfig(dir);
    clearSqliteCache();
  });
  afterEach(() => cleanup(dir));

  it("pre-inserted seq with different id appears in conflicts[]", () => {
    // Seed a JSONL event at seq 3.
    const jsonlEvent = {
      seq: 3,
      id: "jsonl-uuid",
      ts: new Date().toISOString(),
      source: "git",
      type: "git.commit",
      data: { sha: "conflict-sha" },
    };
    // …plus a non-conflicting neighbour, which must still migrate.
    const goodEvent = {
      seq: 4,
      id: "jsonl-uuid-ok",
      ts: new Date().toISOString(),
      source: "git",
      type: "git.commit",
      data: { sha: "fine-sha" },
    };
    writeFileSync(
      eventLogPath("git"),
      JSON.stringify(jsonlEvent) + "\n" + JSON.stringify(goodEvent) + "\n"
    );

    // Pre-insert a row in the DB with seq 3 but a DIFFERENT id.
    const db = new Database(eventDbPath());
    db.exec(
      "CREATE TABLE IF NOT EXISTS events (" +
      "seq INTEGER PRIMARY KEY, id TEXT NOT NULL, ts TEXT NOT NULL, " +
      "source TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)"
    );
    db.prepare(
      "INSERT INTO events (seq, id, ts, source, type, data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      3,
      "db-uuid-different",
      "2026-01-01T00:00:00.000Z",
      "git",
      "git.commit",
      JSON.stringify({ sha: "db-sha" })
    );
    db.close();

    const report = migrateEventsToSqlite({ apply: true });

    expect(report.conflicts.length).toBe(1);
    expect(report.conflicts[0]!.seq).toBe(3);
    expect(report.conflicts[0]!.existingId).toBe("db-uuid-different");
    expect(report.conflicts[0]!.incomingId).toBe("jsonl-uuid");
    // The conflicting event was NOT inserted, but its neighbour was.
    expect(report.inserted).toBe(1);

    const after = new Database(eventDbPath());
    const rows = after
      .prepare("SELECT seq, id FROM events ORDER BY seq")
      .all() as Array<{ seq: number; id: string }>;
    after.close();

    expect(rows).toEqual([
      { seq: 3, id: "db-uuid-different" }, // untouched — the migration did not overwrite it
      { seq: 4, id: "jsonl-uuid-ok" },     // migrated despite its neighbour conflicting
    ]);
  });
});

// ─── Criterion 20: meta.json is advanced ──────────────────────────────────────

describe("Migration — criterion 20: meta.json is advanced", () => {
  let dir = "";
  beforeEach(() => {
    dir = "/tmp/executive-test-migrate-" + randomUUID();
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => cleanup(dir));

  it("currentSeq() >= max migrated seq after apply", () => {
    const seeded = seedJsonlEvents(dir);
    const maxSeq = Math.max(...seeded.map((e) => e.seq));

    // Reset meta.json to 0 so we can verify the migration advances it.
    const metaPath = dir + "/meta.json";
    writeFileSync(metaPath, JSON.stringify({ lastSeq: 0 }) + "\n");

    migrateEventsToSqlite({ apply: true });

    // currentSeq reads meta.json at call time.
    expect(currentSeq()).toBeGreaterThanOrEqual(maxSeq);
  });
});

// ─── Criterion 21: JSONL files are untouched ──────────────────────────────────

describe("Migration — criterion 21: JSONL files untouched", () => {
  let dir = "";
  beforeEach(() => {
    dir = "/tmp/executive-test-migrate-" + randomUUID();
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => cleanup(dir));

  it("jsonl files are byte-identical before and after --apply", () => {
    const seeded = seedJsonlEvents(dir);

    // Snapshot all jsonl files.
    const before: Record<string, string> = {};
    for (const source of ["git", "terminal", "editor", "system", "screen"] as const) {
      const p = eventLogPath(source);
      if (existsSync(p)) {
        before[source] = readFileSync(p, "utf-8");
      }
    }

    migrateEventsToSqlite({ apply: true });

    // Verify every file is identical.
    for (const source of ["git", "terminal", "editor", "system", "screen"] as const) {
      if (before[source] !== undefined) {
        const after = readFileSync(eventLogPath(source), "utf-8");
        expect(after).toBe(before[source]);
      }
    }
  });
});
