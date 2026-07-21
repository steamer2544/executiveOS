import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { runSynth } from "./synth.js";
import { MockSynthesizer } from "./mock.js";
import * as git from "../executor/git.js";
import type { Config } from "../config.js";

function createTempGitRepo(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), "executive-instr-git-" + randomUUID());
  mkdirSync(dir, { recursive: true });
  const { spawnSync } = require("node:child_process");
  const initRes = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  if (initRes.status !== 0) throw new Error("git init failed: " + (initRes.stderr || ""));
  git.checkoutNewBranch(dir, "main");
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), ".executive/\n");
  git.stageAll(dir);
  git.commit(dir, "initial commit");
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1, createdAt: new Date().toISOString(), timezone: "Asia/Bangkok",
    watch: { git: { enabled: true, repoPath: process.cwd(), pollMs: 5000 }, fs: { enabled: true, paths: [process.cwd() + "/src"], debounceMs: 300 } },
    state: { intervalMs: 30000 },
    worker: { backend: "mock", baseUrl: "https://gateway.9arm.co", model: "qwen3.6-35b-a3b", apiKeyEnv: "EXECUTIVE_WORKER_KEY", maxTokens: 1024, timeoutMs: 30000, autoInvoke: false },
    executor: { branchPrefix: "executive/change-", defaultTestCommand: null },
    synth: { maxFileBytes: 100000, maxFiles: 10 },
    ...overrides,
  } as Config;
}

describe("runSynth instruction override", () => {
  let home: string;
  let repo: ReturnType<typeof createTempGitRepo>;

  beforeEach(() => {
    home = join(tmpdir(), "executive-instr-home-" + randomUUID());
    mkdirSync(home, { recursive: true });
    process.env.EXECUTIVE_HOME = home;
    repo = createTempGitRepo();
  });

  afterEach(() => {
    repo.cleanup();
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    delete process.env.EXECUTIVE_HOME;
  });

  // 1. Instruction override works without proposal.json
  it("runs synth with instruction override and returns ok", async () => {
    const report = await runSynth({
      repoRoot: repo.dir,
      config: makeConfig(),
      instruction: "add a README note",
      synthOverride: new MockSynthesizer(),
    });

    expect(report.ok).toBe(true);
    expect(report.changeSetWritten).toBe(true);
    expect(report.proposalId).toBe("instruction");
    expect(report.error).toBeNull();
  });

  // 2. Without instruction and no proposal.json → fails with "no proposal" message
  it("returns ok:false when no instruction and no proposal.json exists", async () => {
    const report = await runSynth({
      repoRoot: repo.dir,
      config: makeConfig(),
      synthOverride: new MockSynthesizer(),
    });

    expect(report.ok).toBe(false);
    expect(report.changeSetWritten).toBe(false);
    expect(report.messages.some((m) => m.toLowerCase().includes("no proposal"))).toBe(true);
  });

  // 3. Instruction path leaves the working tree clean (dry-run only)
  it("leaves the repo working tree clean after instruction-based synth", async () => {
    await runSynth({
      repoRoot: repo.dir,
      config: makeConfig(),
      instruction: "add a README note",
      synthOverride: new MockSynthesizer(),
    });

    // MockSynthesizer's ChangeSet only proposes writing SYNTH_NOTE.md;
    // dry-run mode never touches disk.
    expect(git.isWorkingTreeClean(repo.dir)).toBe(true);
  });
});
