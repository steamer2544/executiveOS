// Tests for src/config-backup.ts — rotating backups of config.json (Phase 43).
//
// Every test sets EXECUTIVE_HOME to a temp dir and tears it down afterward.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { backupConfig, listConfigBackups, MAX_CONFIG_BACKUPS } from "./config-backup.js";
import { configBackupDir, configPath } from "./paths.js";
import { bootstrap } from "./bootstrap.js";
import { updateAutonomyConfig, updateScreenConfig, updateTranscribeConfig } from "./config.js";

// ─── Temp home setup ──────────────────────────────────────────────────────────

const TEST_HOME = "/tmp/executive-test-config-backup-" + randomUUID();

function setupHome(): void {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env.EXECUTIVE_HOME = TEST_HOME;
}

function teardownHome(): void {
  try {
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
  } catch { /* ignore */ }
  delete process.env.EXECUTIVE_HOME;
}

function writeConfig(content: string): void {
  writeFileSync(configPath(), content);
}

function readConfig(): string {
  return readFileSync(configPath(), "utf-8");
}

/**
 * Force backupConfig() to fail, portably: plant a regular file where the backup
 * directory belongs so mkdirSync throws EEXIST. chmod is NOT usable for this —
 * on Windows it does not stop writes into a directory (verified), which would
 * make every "backup failed" test pass vacuously.
 */
function blockBackupDir(): void {
  writeFileSync(configBackupDir(), "not a directory");
}

// ─── Criterion 1: no-op when config.json is absent ───────────────────────────

describe("backupConfig — no config on disk", () => {
  beforeEach(() => { setupHome(); });
  afterEach(() => { teardownHome(); });

  test("no config.json → no-op, creates no directory, does not throw (criterion 1)", () => {
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(configBackupDir())).toBe(false);

    expect(() => backupConfig()).not.toThrow();

    expect(existsSync(configBackupDir())).toBe(false);
  });
});

// ─── Criteria 2-3: genesis + one rotating backup ──────────────────────────────

describe("backupConfig — genesis + rotating snapshot", () => {
  beforeEach(() => { setupHome(); });
  afterEach(() => { teardownHome(); });

  test("with config present → genesis exists, byte-identical (criterion 2)", () => {
    const content = JSON.stringify({ version: 1, createdAt: "x", timezone: "Asia/Bangkok" }, null, 2) + "\n";
    writeConfig(content);

    backupConfig();

    const genesisPath = configBackupDir() + "/config-genesis.json";
    expect(existsSync(genesisPath)).toBe(true);
    expect(readFileSync(genesisPath, "utf-8")).toBe(content);
  });

  test("and exactly one rotating config-<ts>.json also exists, byte-identical (criterion 3)", () => {
    const content = JSON.stringify({ version: 1, createdAt: "x", timezone: "Asia/Bangkok" }, null, 2) + "\n";
    writeConfig(content);

    backupConfig();

    const backups = listConfigBackups();
    expect(backups).toHaveLength(1);
    expect(readFileSync(backups[0]!, "utf-8")).toBe(content);
  });
});

// ─── Criterion 4: genesis is never overwritten ────────────────────────────────

describe("backupConfig — genesis never overwritten", () => {
  beforeEach(() => { setupHome(); });
  afterEach(() => { teardownHome(); });

  test("back up, change config, back up again → genesis still holds first content (criterion 4)", () => {
    const first = JSON.stringify({ version: 1, createdAt: "x", timezone: "Asia/Bangkok", agent: { enabled: false } }, null, 2) + "\n";
    const second = JSON.stringify({ version: 1, createdAt: "x", timezone: "Asia/Bangkok", agent: { enabled: true } }, null, 2) + "\n";

    writeConfig(first);
    backupConfig();

    writeConfig(second);
    backupConfig();

    const genesisPath = configBackupDir() + "/config-genesis.json";
    expect(existsSync(genesisPath)).toBe(true);
    expect(readFileSync(genesisPath, "utf-8")).toBe(first);
  });
});

// ─── Criterion 5: identical content is skipped ────────────────────────────────

describe("backupConfig — identical content skipped", () => {
  beforeEach(() => { setupHome(); });
  afterEach(() => { teardownHome(); });

  test("calling backupConfig twice with no change → exactly one rotating backup (criterion 5)", () => {
    const content = JSON.stringify({ version: 1, createdAt: "x", timezone: "Asia/Bangkok" }, null, 2) + "\n";
    writeConfig(content);

    backupConfig();
    backupConfig();

    const backups = listConfigBackups();
    expect(backups).toHaveLength(1);
  });

  test("skip still applies once SEVERAL backups exist (criterion 5, regression)", () => {
    // The single-backup case above cannot distinguish "compare against newest"
    // from "compare against oldest" — with one backup they are the same file.
    // Build up three distinct backups first, then re-run with no change.
    for (const note of ["a", "b", "c"]) {
      writeConfig(JSON.stringify({ version: 1, timezone: "Asia/Bangkok", note }, null, 2) + "\n");
      backupConfig();
      const start = Date.now();
      while (Date.now() - start < 15) { /* spin: distinct ms → distinct filename */ }
    }
    expect(listConfigBackups()).toHaveLength(3);

    // config.json is unchanged since the last backup → nothing new must be written.
    backupConfig();
    backupConfig();

    expect(listConfigBackups()).toHaveLength(3);
  });
});

// ─── Criteria 6-7: rotation keeps newest 10, genesis survives ─────────────────

describe("backupConfig — rotation", () => {
  beforeEach(() => { setupHome(); });
  afterEach(() => { teardownHome(); });

  test("13 different configs → exactly 10 rotating backups, newest 10 kept (criterion 6)", () => {
    const first = JSON.stringify({ version: 1, createdAt: "x", timezone: "Asia/Bangkok", note: "first" }, null, 2) + "\n";
    writeConfig(first);
    backupConfig();

    for (let i = 2; i <= 13; i++) {
      const content = JSON.stringify({ version: 1, createdAt: "x", timezone: "Asia/Bangkok", note: "run-" + i }, null, 2) + "\n";
      writeConfig(content);
      backupConfig();
      // Small delay to avoid timestamp collision (same ms → same filename → overwrite).
      if (i < 13) {
        const start = Date.now();
        while (Date.now() - start < 15) { /* spin */ }
      }
    }

    const backups = listConfigBackups();
    expect(backups).toHaveLength(10);

    // Verify the kept backups contain the newest 10 contents (runs 4-13).
    const contents = backups.map((p) => readFileSync(p, "utf-8"));
    const notes = contents.map((c) => JSON.parse(c).note);
    for (let i = 4; i <= 13; i++) {
      expect(notes).toContain("run-" + i);
    }
    // Oldest 3 should be gone.
    for (let i = 1; i <= 3; i++) {
      expect(notes).not.toContain("run-" + i);
    }
    // "first" should definitely be gone.
    expect(notes).not.toContain("first");
  });

  test("genesis survives rotation — still exists with original content (criterion 7)", () => {
    const first = JSON.stringify({ version: 1, createdAt: "x", timezone: "Asia/Bangkok", note: "first" }, null, 2) + "\n";
    writeConfig(first);
    backupConfig();

    for (let i = 2; i <= 13; i++) {
      const content = JSON.stringify({ version: 1, createdAt: "x", timezone: "Asia/Bangkok", note: "run-" + i }, null, 2) + "\n";
      writeConfig(content);
      backupConfig();
      if (i < 13) {
        const start = Date.now();
        while (Date.now() - start < 15) { /* spin */ }
      }
    }

    const genesisPath = configBackupDir() + "/config-genesis.json";
    expect(existsSync(genesisPath)).toBe(true);
    expect(readFileSync(genesisPath, "utf-8")).toBe(first);
  });
});

// ─── Criterion 8: listConfigBackups newest-first, no genesis ──────────────────

describe("listConfigBackups", () => {
  beforeEach(() => { setupHome(); });
  afterEach(() => { teardownHome(); });

  test("returns newest-first, never includes config-genesis.json (criterion 8)", () => {
    // Three DIFFERENT configs, so the ordering assertion has something to order.
    // With a single backup, "sorted newest-first" is vacuously true.
    for (const note of ["oldest", "middle", "newest"]) {
      writeConfig(JSON.stringify({ version: 1, createdAt: "x", timezone: "Asia/Bangkok", note }, null, 2) + "\n");
      backupConfig();
      const start = Date.now();
      while (Date.now() - start < 15) { /* spin: distinct ms → distinct filename */ }
    }

    const backups = listConfigBackups();
    expect(backups).toHaveLength(3);

    // Genesis is never listed.
    for (const p of backups) {
      const name = p.split("/").pop()!;
      expect(name.startsWith("config-")).toBe(true);
      expect(name).not.toBe("config-genesis.json");
    }
    expect(existsSync(configBackupDir() + "/config-genesis.json")).toBe(true);

    // Assert the ACTUAL order against known content, not against a re-sort of
    // the same array (which would pass for any ordering).
    const notes = backups.map((p) => JSON.parse(readFileSync(p, "utf-8")).note);
    expect(notes).toEqual(["newest", "middle", "oldest"]);
  });
});

// ─── Criterion 9: never throws ───────────────────────────────────────────────

describe("backupConfig — never throws", () => {
  beforeEach(() => { setupHome(); });
  afterEach(() => { teardownHome(); });

  test("backup directory cannot be created → returns normally (criterion 9)", () => {
    const content = JSON.stringify({ version: 1, createdAt: "x", timezone: "Asia/Bangkok" }, null, 2) + "\n";
    writeConfig(content);

    // Plant a regular FILE where the backup directory belongs, so mkdirSync
    // throws EEXIST. NOTE: chmod(dir, 0o444) does NOT work here — on Windows it
    // does not prevent creating files inside a directory, so the backup would
    // quietly succeed and this test would assert nothing.
    blockBackupDir();

    expect(() => backupConfig()).not.toThrow();

    // Prove the failure was real, not silently worked around.
    expect(listConfigBackups()).toEqual([]);
  });
});

// ─── Criterion 10: end-to-end via updateAutonomyConfig ────────────────────────

describe("End-to-end — updateAutonomyConfig", () => {
  beforeEach(() => { setupHome(); });
  afterEach(() => { teardownHome(); });

  test("backup exists holding value from BEFORE the call (criterion 10)", () => {
    // bootstrap creates the directory tree and config.json.
    bootstrap();

    // Write a known initial config.
    const initial = JSON.stringify(
      { version: 1, createdAt: "2026-01-01T00:00:00.000Z", timezone: "Asia/Bangkok", advisor: { enabled: false } },
      null, 2
    ) + "\n";
    writeConfig(initial);

    // Perform the update.
    updateAutonomyConfig({ advisorEnabled: true });

    // (a) config.json has the new value.
    expect(JSON.parse(readConfig()).advisor.enabled).toBe(true);

    // (b) a backup exists holding the value from BEFORE the call.
    // Assert the SPECIFIC field, not a substring: the merged config contains
    // many default-off blocks, so `toContain('"enabled": false')` matches even a
    // backup taken AFTER the write — i.e. it passes for a worthless backup.
    const backups = listConfigBackups();
    expect(backups.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(backups[0]!, "utf-8")).advisor.enabled).toBe(false);
  });
});

// ─── Criterion 11: second writer (updateScreenConfig) ─────────────────────────

describe("End-to-end — updateScreenConfig", () => {
  beforeEach(() => { setupHome(); });
  afterEach(() => { teardownHome(); });

  test("updateScreenConfig also produces a backup (criterion 11)", () => {
    const initial = JSON.stringify(
      { version: 1, createdAt: "2026-01-01T00:00:00.000Z", timezone: "Asia/Bangkok", screen: { window: { enabled: false } } },
      null, 2
    ) + "\n";
    writeConfig(initial);

    updateScreenConfig({ window: { enabled: true } });

    expect(JSON.parse(readConfig()).screen.window.enabled).toBe(true);

    // Same reasoning as criterion 10: assert the specific field, so a backup
    // taken after the write fails this test instead of passing on a coincidence.
    const backups = listConfigBackups();
    expect(backups.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(backups[0]!, "utf-8")).screen.window.enabled).toBe(false);
  });
});

// ─── Criterion 12: backup failure does not block the write ─────────────────────

describe("backup failure does not block the write", () => {
  beforeEach(() => { setupHome(); });
  afterEach(() => { teardownHome(); });

  test("backup failure → config.json still updated (criterion 12)", () => {
    const initial = JSON.stringify(
      { version: 1, createdAt: "2026-01-01T00:00:00.000Z", timezone: "Asia/Bangkok", advisor: { enabled: false } },
      null, 2
    ) + "\n";
    writeConfig(initial);

    blockBackupDir();

    updateAutonomyConfig({ advisorEnabled: true });

    // The write went through despite the backup failing...
    expect(JSON.parse(readConfig()).advisor.enabled).toBe(true);
    // ...and the backup really did fail (otherwise this proves nothing).
    expect(listConfigBackups()).toEqual([]);
  });
});

// ─── Criterion 13: happy path unchanged ───────────────────────────────────────

describe("updateTranscribeConfig — happy path unchanged", () => {
  beforeEach(() => { setupHome(); });
  afterEach(() => { teardownHome(); });

  test("parsed JSON round-trips the patch and file ends with trailing newline (criterion 13)", () => {
    const initial = JSON.stringify(
      { version: 1, createdAt: "2026-01-01T00:00:00.000Z", timezone: "Asia/Bangkok", transcribe: { mode: "webspeech" } },
      null, 2
    ) + "\n";
    writeConfig(initial);

    const patch = { mode: "whisper-api", baseUrl: "http://example.com", model: "whisper-1" };
    updateTranscribeConfig(patch);

    const cfg = readConfig();
    const parsed = JSON.parse(cfg);
    expect(parsed.transcribe.mode).toBe("whisper-api");
    expect(parsed.transcribe.baseUrl).toBe("http://example.com");
    expect(parsed.transcribe.model).toBe("whisper-1");
    expect(cfg.endsWith("\n")).toBe(true);
  });
});
