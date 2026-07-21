import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { executeProposal } from "./execute.js";
import { MockSynthesizer } from "../synth/mock.js";
import * as git from "../executor/git.js";
import type { Config } from "../config.js";
import type { Proposal } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTempGitRepo(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), "executive-exec-git-" + randomUUID());
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
  const baseWatch = { git: { enabled: true, repoPath: process.cwd(), pollMs: 5000 }, fs: { enabled: true, paths: [process.cwd() + "/src"], debounceMs: 300 } };
  const watch = overrides.watch ?? baseWatch;
  return {
    version: 1, createdAt: new Date().toISOString(), timezone: "Asia/Bangkok",
    watch,
    state: { intervalMs: 30000 },
    worker: { backend: "mock", baseUrl: "https://gateway.9arm.co", model: "qwen3.6-35b-a3b", apiKeyEnv: "EXECUTIVE_WORKER_KEY", maxTokens: 1024, timeoutMs: 30000, autoInvoke: false },
    executor: { branchPrefix: "executive/change-", defaultTestCommand: null },
    synth: { maxFileBytes: 100000, maxFiles: 10 },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "watch")),
  } as Config;
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1", createdAt: new Date().toISOString(), category: "work",
    title: "Fix thing", detail: "d", action: "do the fix", status: "pending",
    executable: true, repo: undefined, files: undefined,
    ...overrides,
  };
}

type ExecResult = NonNullable<Proposal["execution"]>;

type WatchRepos = { git: { enabled?: boolean; repoPath?: string; pollMs?: number }; fs: { enabled?: boolean; paths?: string[]; debounceMs?: number }; repos: Array<{ path: string; name?: string; pollMs?: number; watchFiles?: boolean; filePaths?: string[]; fileDebounceMs?: number }> };

function reposWatch(repos: WatchRepos["repos"]): WatchRepos {
  return {
    git: { enabled: true, repoPath: process.cwd(), pollMs: 5000 },
    fs: { enabled: true, paths: [process.cwd() + "/src"], debounceMs: 300 },
    repos,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("executeProposal", () => {
  let home: string;
  let repo: ReturnType<typeof createTempGitRepo>;

  beforeEach(() => {
    home = join(tmpdir(), "executive-exec-home-" + randomUUID());
    mkdirSync(home, { recursive: true });
    process.env.EXECUTIVE_HOME = home;
    repo = createTempGitRepo();
  });

  afterEach(() => {
    repo.cleanup();
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    delete process.env.EXECUTIVE_HOME;
  });

  // 1. Non-executable → short-circuit
  it("returns ran:false for non-executable proposals", async () => {
    const r = await executeProposal(
      makeProposal({ executable: false }),
      makeConfig(),
    ) as ExecResult;

    expect(r.ran).toBe(false);
    expect(r.applied).toBe(false);
    expect(r.branch).toBeNull();
    expect(r.changeSetWritten).toBe(false);
    expect(r.valid).toBe(false);
    expect(r.testPassed).toBeNull();
    expect(r.message).toContain("not executable");
  });

  // 2. Executable + dry-run (no apply)
  it("runs synth dry-run without applying when apply is not set", async () => {
    const config = makeConfig({
      watch: reposWatch([{
        path: repo.dir,
        name: "r1",
        pollMs: 5000,
        watchFiles: true,
        filePaths: [repo.dir + "/src"],
        fileDebounceMs: 300,
      }]),
    });

    const r = await executeProposal(
      makeProposal({ repo: "r1" }),
      config,
      { synthOverride: new MockSynthesizer() },
    ) as ExecResult;

    expect(r.ran).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.valid).toBe(true);
    expect(r.changeSetWritten).toBe(true);
    expect(r.branch).toBeNull();
    expect(r.testPassed).toBeNull();
    expect(r.message).toMatch(/dry-run/i);

    // Working tree must still be clean — dry-run never touches disk.
    expect(git.isWorkingTreeClean(repo.dir)).toBe(true);
  });

  // 3. Executable + apply:true
  it("commits to an isolated branch when apply:true", async () => {
    const config = makeConfig({
      watch: reposWatch([{
        path: repo.dir,
        name: "r1",
        pollMs: 5000,
        watchFiles: true,
        filePaths: [repo.dir + "/src"],
        fileDebounceMs: 300,
      }]),
    });

    const r = await executeProposal(
      makeProposal({ repo: "r1" }),
      config,
      { apply: true, synthOverride: new MockSynthesizer() },
    ) as ExecResult;

    expect(r.ran).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.valid).toBe(true);
    expect(r.changeSetWritten).toBe(true);
    expect(r.branch).toMatch(/^executive\/change-/);
    expect(git.branchExists(repo.dir, r.branch!)).toBe(true);

    // HEAD must be back on main (executor always returns to original branch).
    expect(git.currentBranch(repo.dir)).toBe("main");

    // Working tree on main must be clean.
    expect(git.isWorkingTreeClean(repo.dir)).toBe(true);
  });

  // 4. Executable + unsafe changeset → rejected by validation
  it("rejects unsafe changeset paths and leaves repo clean", async () => {
    class EvilSynthesizer {
      readonly name = "evil";
      async synthesize() {
        return {
          changeSet: {
            id: "evil",
            title: "evil",
            ops: [{ op: "write", path: "../../etc/passwd", content: "x" }],
            test: null,
            commitMessage: "evil",
            basedOnProposal: "p1",
          },
          raw: "{}",
          backend: "evil",
        };
      }
    }

    const config = makeConfig({
      watch: reposWatch([{
        path: repo.dir,
        name: "r1",
        pollMs: 5000,
        watchFiles: true,
        filePaths: [repo.dir + "/src"],
        fileDebounceMs: 300,
      }]),
    });

    const r = await executeProposal(
      makeProposal({ repo: "r1" }),
      config,
      { apply: true, synthOverride: new EvilSynthesizer() as any },
    ) as ExecResult;

    expect(r.ran).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.valid).toBe(false);
    expect(r.branch).toBeNull();

    // Nothing should have been created on disk.
    expect(git.isWorkingTreeClean(repo.dir)).toBe(true);
    expect(git.branchExists(repo.dir, "executive/change-evil")).toBe(false);
  });
});
