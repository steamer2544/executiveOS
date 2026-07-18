// Offline tests for Worker identity loading + bootstrap.
// No network, no LLM calls. Uses a temp EXECUTIVE_HOME per test.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { execRoot } from "../paths.js";
import { bootstrap } from "../bootstrap.js";
import { DEFAULT_IDENTITY, loadWorkerIdentity } from "./identity.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_DIR = "/tmp/executive-test-identity-" + randomUUID();

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

// ─── 1. Missing file → default ────────────────────────────────────────────────

describe("loadWorkerIdentity — missing file", () => {
  let dir: string;

  beforeEach(() => {
    dir = TEST_DIR + "-missing-" + randomUUID();
    mkdirSync(dir, { recursive: true });
    setExecutiveHome(dir);
  });

  afterEach(() => cleanup(dir));

  it("returns DEFAULT_IDENTITY when claude.md is absent", () => {
    const identity = loadWorkerIdentity();
    expect(identity).toBe(DEFAULT_IDENTITY);
  });
});

// ─── 2. Present file → its contents ───────────────────────────────────────────

describe("loadWorkerIdentity — present file", () => {
  let dir: string;

  beforeEach(() => {
    dir = TEST_DIR + "-present-" + randomUUID();
    mkdirSync(dir, { recursive: true });
    setExecutiveHome(dir);
  });

  afterEach(() => cleanup(dir));

  it("returns the file contents (raw, untrimmed)", () => {
    const custom = "# Custom\n\nYou are a cat.";
    writeFileSync(execRoot() + "/claude.md", custom);
    const identity = loadWorkerIdentity();
    expect(identity).toBe(custom);
  });
});

// ─── 3. Blank file → default ─────────────────────────────────────────────────

describe("loadWorkerIdentity — blank file", () => {
  let dir: string;

  beforeEach(() => {
    dir = TEST_DIR + "-blank-" + randomUUID();
    mkdirSync(dir, { recursive: true });
    setExecutiveHome(dir);
  });

  afterEach(() => cleanup(dir));

  it("returns DEFAULT_IDENTITY when file is whitespace-only", () => {
    writeFileSync(execRoot() + "/claude.md", "   \n  \t  \n");
    const identity = loadWorkerIdentity();
    expect(identity).toBe(DEFAULT_IDENTITY);
  });
});

// ─── 4. Bootstrap writes default when absent ──────────────────────────────────

describe("bootstrap — writes claude.md", () => {
  let dir: string;

  beforeEach(() => {
    dir = TEST_DIR + "-bootstrap-absent-" + randomUUID();
    mkdirSync(dir, { recursive: true });
    setExecutiveHome(dir);
  });

  afterEach(() => cleanup(dir));

  it("creates claude.md equal to DEFAULT_IDENTITY when absent", async () => {
    await bootstrap();
    const path = execRoot() + "/claude.md";
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toBe(DEFAULT_IDENTITY);
  });
});

// ─── 5. Bootstrap never overwrites ────────────────────────────────────────────

describe("bootstrap — never overwrites", () => {
  let dir: string;

  beforeEach(() => {
    dir = TEST_DIR + "-bootstrap-overwrite-" + randomUUID();
    mkdirSync(dir, { recursive: true });
    setExecutiveHome(dir);
  });

  afterEach(() => cleanup(dir));

  it("leaves existing claude.md unchanged after bootstrap", async () => {
    const custom = "# My custom identity\n\nBe helpful.";
    writeFileSync(execRoot() + "/claude.md", custom);
    await bootstrap();
    const path = execRoot() + "/claude.md";
    const content = readFileSync(path, "utf-8");
    expect(content).toBe(custom);
  });
});
