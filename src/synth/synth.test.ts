// Unit tests for Phase 7: Synthesizer (Proposal → ChangeSet).
// 100% OFFLINE — no network, no real LLM, no tokens spent.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { execRoot, changeSetPath, synthReportPath, proposalPath, proposalsDir } from "../paths.js";
import type { Config } from "../config.js";
import type { Proposal } from "../worker/types.js";
import type { State, Context } from "../state/types.js";
import type { ChangeSet, ExecReport, ValidationResult } from "../executor/types.js";
import { validateChangeSet } from "../executor/executor.js";
import { applyChangeSet } from "../executor/executor.js";
import { buildState, writeState } from "../state/builder.js";
import { MockSynthesizer } from "./mock.js";
import {
  buildSynthSystemPrompt,
  buildSynthUserMessage,
  buildSynthRequestBody,
  parseChangeSetJson,
  AnthropicSynthesizer,
} from "./anthropic.js";
import { createSynthesizer } from "./factory.js";
import { runSynth, writeChangeSet, writeSynthReport } from "./synth.js";
import type { Synthesizer, SynthInput, SynthResult } from "./types.js";
import * as git from "../executor/git.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), "executive-test-synth-" + randomUUID());
// EXECUTIVE_HOME lives OUTSIDE the git repo root so that .executive/ doesn't
// show up as an untracked directory and break isWorkingTreeClean().
const EXEC_HOME = join(TEST_DIR, "exec-home");

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

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    timezone: "Asia/Bangkok",
    watch: {
      git: { enabled: true, repoPath: process.cwd(), pollMs: 5000 },
      fs: { enabled: true, paths: [process.cwd() + "/src"], debounceMs: 300 },
    },
    state: { intervalMs: 30000 },
    worker: {
      backend: "mock",
      baseUrl: "https://gateway.9arm.co",
      model: "qwen3.6-35b-a3b",
      apiKeyEnv: "EXECUTIVE_WORKER_KEY",
      maxTokens: 1024,
      timeoutMs: 30000,
      autoInvoke: false,
    },
    executor: {
      branchPrefix: "executive/change-",
      defaultTestCommand: null,
    },
    synth: {
      maxFileBytes: 100000,
      maxFiles: 10,
    },
    ...overrides,
  };
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "test-proposal-" + randomUUID().slice(0, 8),
    generatedAt: new Date().toISOString(),
    status: "ok",
    backend: "mock",
    action: {
      kind: "fix_tests",
      reason: "test",
      priority: 100,
      confidence: 0.97,
      forbidden: false,
      disposition: "act",
    },
    summary: "test proposal summary",
    steps: ["step 1", "step 2"],
    raw: "step 1\nstep 2",
    error: null,
    basedOn: {
      stateGeneratedAt: new Date().toISOString(),
      topActionKind: "fix_tests",
    },
    ...overrides,
  };
}

function makeState(overrides: Partial<State> = {}): State {
  const now = new Date("2026-07-17T00:00:00.000Z");
  return {
    generatedAt: now.toISOString(),
    eventCount: 0,
    lastEventTs: null,
    currentProject: null,
    currentTask: null,
    deadline: null,
    currentFile: null,
    recentFiles: [],
    git: { branch: null, lastCommit: null },
    tests: "unknown",
    blocked: false,
    blockedReason: null,
    activity: { active: true, idleMs: null },
    activeRepo: null,
    repos: [],
    ...overrides,
  };
}

/**
 * Create a temp git repo with an initial commit.
 * Returns { dir, cleanup }.
 */
function createTempGitRepo(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), "executive-synth-git-" + randomUUID());
  mkdirSync(dir, { recursive: true });

  const { spawnSync } = require("node:child_process");
  const initRes = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  if (initRes.status !== 0) {
    throw new Error("git init failed: " + (initRes.stderr || ""));
  }
  git.checkoutNewBranch(dir, "main");

  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });

  // Ignore .executive/ so setting EXECUTIVE_HOME to dir/.executive doesn't
  // pollute the working tree (untracked dir → isWorkingTreeClean = false).
  writeFileSync(join(dir, ".gitignore"), ".executive/\n");
  git.stageAll(dir);
  git.commit(dir, "initial commit");

  return { dir, cleanup: () => cleanup(dir) };
}

// ─── 1. MockSynthesizer deterministic ─────────────────────────────────────────

describe("MockSynthesizer — deterministic", () => {
  it("same input twice → identical SynthResult", async () => {
    const synth = new MockSynthesizer();
    const input: SynthInput = {
      proposal: makeProposal(),
      summary: "test",
      files: [],
    };
    const r1 = await synth.synthesize(input);
    const r2 = await synth.synthesize(input);
    expect(r1).toEqual(r2);
  });

  it("the ChangeSet passes validateChangeSet", () => {
    const synth = new MockSynthesizer();
    const input: SynthInput = {
      proposal: makeProposal(),
      summary: "test",
      files: [],
    };
    return synth.synthesize(input).then((result) => {
      const validation = validateChangeSet(result.changeSet, "/tmp");
      expect(validation.ok).toBe(true);
    });
  });

  it("name is 'mock'", () => {
    expect(new MockSynthesizer().name).toBe("mock");
  });
});

// ─── 2. parseChangeSetJson ────────────────────────────────────────────────────

describe("parseChangeSetJson", () => {
  it("parses a fenced ```json {…} ``` block", () => {
    const text = '```json\n{"id":"abc","title":"t","ops":[{"op":"write","path":"x","content":"c"}]}\n```';
    const cs = parseChangeSetJson(text);
    expect(cs.id).toBe("abc");
    expect(cs.title).toBe("t");
    expect(cs.ops.length).toBe(1);
  });

  it("parses a plain ``` block", () => {
    const text = '```\n{"id":"abc","title":"t","ops":[{"op":"write","path":"x","content":"c"}]}\n```';
    const cs = parseChangeSetJson(text);
    expect(cs.id).toBe("abc");
  });

  it("fills defaults for missing test/commitMessage/id", () => {
    const text = '{"ops":[{"op":"write","path":"x","content":"c"}]}';
    const cs = parseChangeSetJson(text);
    expect(cs.test).toBeNull();
    expect(cs.commitMessage).toBe("synthesized change"); // default title
    expect(cs.id).toBe("synth"); // title is empty → slug is empty → fallback to "synth"
  });

  it("fills id with synth-<slug> when title is present", () => {
    const text = '{"ops":[{"op":"write","path":"x","content":"c"}],"title":"fix login"}';
    const cs = parseChangeSetJson(text);
    expect(cs.id).toBe("synth-fixlogin");
  });

  it("throws on non-JSON garbage", () => {
    expect(() => parseChangeSetJson("not json at all")).toThrow("synth: could not parse ChangeSet JSON");
  });

  it("throws on empty string", () => {
    expect(() => parseChangeSetJson("")).toThrow("synth: could not parse ChangeSet JSON");
  });

  it("extracts from first { to last }", () => {
    const text = 'some prefix {"id":"x","title":"t","ops":[{"op":"write","path":"y","content":"z"}]} suffix';
    const cs = parseChangeSetJson(text);
    expect(cs.id).toBe("x");
  });
});

// ─── 3. buildSynthRequestBody ─────────────────────────────────────────────────

describe("buildSynthRequestBody", () => {
  it("Anthropic shape — top-level system string, single user message, temperature: 0", () => {
    const input: SynthInput = {
      proposal: makeProposal(),
      summary: "test context",
      files: [],
    };
    const body = buildSynthRequestBody(input, "test-model", 512);
    const obj = body as Record<string, unknown>;

    expect(obj.model).toBe("test-model");
    expect(obj.max_tokens).toBe(512);
    expect(obj.temperature).toBe(0);
    expect(typeof obj.system).toBe("string");
    expect((obj.system as string).length).toBeGreaterThan(0);

    expect(Array.isArray(obj.messages)).toBe(true);
    const msgs = obj.messages as Array<{ role: string; content: string }>;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe("user");
    expect(typeof msgs[0]!.content).toBe("string");
  });
});

describe("buildSynthSystemPrompt", () => {
  it("returns a non-empty string about being a Synthesizer", () => {
    const prompt = buildSynthSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Synthesizer");
  });
});

describe("buildSynthUserMessage", () => {
  it("serializes proposal and files deterministically", () => {
    const input: SynthInput = {
      proposal: makeProposal(),
      summary: "test",
      files: [{ path: "a.ts", content: "hello", bytes: 5 }],
    };
    const msg = buildSynthUserMessage(input);
    const parsed = JSON.parse(msg);
    expect(parsed.proposal.summary).toBe("test proposal summary");
    expect(parsed.files.length).toBe(1);
    expect(parsed.files[0]!.path).toBe("a.ts");
  });
});

// ─── 4. selectFiles — explicit wins ───────────────────────────────────────────

describe("runSynth — selectFiles explicit", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("explicitFiles: the report's selectedFiles reflects the explicit list (existing only)", () => {
    const dir = TEST_DIR;
    // Create a proposal
    const proposal = makeProposal();
    const dirProposals = proposalsDir();
    mkdirSync(dirProposals, { recursive: true });
    writeFileSync(proposalPath(), JSON.stringify(proposal, null, 2) + "\n");

    // Create a file to reference
    writeFileSync(join(dir, "a.ts"), "hello");

    const config = makeConfig();
    return runSynth({
      repoRoot: dir,
      config,
      explicitFiles: ["a.ts", "nonexistent.ts"],
      synthOverride: new MockSynthesizer(),
    }).then((report) => {
      expect(report.selectedFiles).toContain("a.ts");
      expect(report.selectedFiles).not.toContain("nonexistent.ts");
      expect(report.ok).toBe(true);
    });
  });
});

// ─── 5. selectFiles — fallback to State ───────────────────────────────────────

describe("runSynth — selectFiles fallback to State", () => {
  beforeEach(() => {
    mkdirSync(EXEC_HOME, { recursive: true });
    setExecutiveHome(EXEC_HOME);
  });
  afterEach(() => cleanup(TEST_DIR));

  it("no explicitFiles → files come from State (currentFile+recentFiles)", () => {
    const dir = TEST_DIR;
    const proposal = makeProposal();
    const dirProposals = proposalsDir();
    mkdirSync(dirProposals, { recursive: true });
    writeFileSync(proposalPath(), JSON.stringify(proposal, null, 2) + "\n");

    // Seed editor.save events so buildState derives currentFile + recentFiles.
    // buildState reads JSONL logs via execRoot() + "/events/", and EXECUTIVE_HOME
    // is set to EXEC_HOME, so events go to EXEC_HOME + "/events/".
    const eventsDirPath = join(EXEC_HOME, "events");
    mkdirSync(eventsDirPath, { recursive: true });

    const editorLog = eventsDirPath + "/editor.jsonl";
    appendFileSync(editorLog, JSON.stringify({ source: "editor", type: "editor.save", seq: 1, ts: "2026-07-17T00:00:01.000Z", data: { path: "src/index.ts" } }) + "\n");
    appendFileSync(editorLog, JSON.stringify({ source: "editor", type: "editor.save", seq: 2, ts: "2026-07-17T00:00:02.000Z", data: { path: "src/util.ts" } }) + "\n");
    appendFileSync(editorLog, JSON.stringify({ source: "editor", type: "editor.save", seq: 3, ts: "2026-07-17T00:00:03.000Z", data: { path: "src/main.ts" } }) + "\n");

    // Create the files so assembleFiles doesn't skip them
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), "main");
    writeFileSync(join(dir, "src", "util.ts"), "util");
    writeFileSync(join(dir, "src", "index.ts"), "index");

    const config = makeConfig();
    return runSynth({
      repoRoot: dir,
      config,
      synthOverride: new MockSynthesizer(),
    }).then((report) => {
      expect(report.selectedFiles).toContain("src/main.ts");
      expect(report.selectedFiles).toContain("src/util.ts");
      expect(report.selectedFiles).toContain("src/index.ts");
    });
  });
});

// ─── 6. assembleFiles bounds ──────────────────────────────────────────────────

describe("runSynth — assembleFiles bounds", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("oversized file (> maxFileBytes) is skipped with a message", () => {
    const dir = TEST_DIR;
    const proposal = makeProposal();
    const dirProposals = proposalsDir();
    mkdirSync(dirProposals, { recursive: true });
    writeFileSync(proposalPath(), JSON.stringify(proposal, null, 2) + "\n");

    // Create a file > 10 bytes
    writeFileSync(join(dir, "big.ts"), "x".repeat(100));

    const config = makeConfig({ synth: { maxFileBytes: 50, maxFiles: 10 } });
    return runSynth({
      repoRoot: dir,
      config,
      explicitFiles: ["big.ts"],
      synthOverride: new MockSynthesizer(),
    }).then((report) => {
      expect(report.selectedFiles).not.toContain("big.ts");
      expect(report.messages.some((m) => m.includes("too large"))).toBe(true);
    });
  });

  it("missing file is skipped with a message", () => {
    const dir = TEST_DIR;
    const proposal = makeProposal();
    const dirProposals = proposalsDir();
    mkdirSync(dirProposals, { recursive: true });
    writeFileSync(proposalPath(), JSON.stringify(proposal, null, 2) + "\n");

    const config = makeConfig();
    return runSynth({
      repoRoot: dir,
      config,
      explicitFiles: ["missing.ts"],
      synthOverride: new MockSynthesizer(),
    }).then((report) => {
      expect(report.selectedFiles).not.toContain("missing.ts");
      expect(report.messages.some((m) => m.includes("not found"))).toBe(true);
    });
  });
});

// ─── 7. runSynth happy path ───────────────────────────────────────────────────

describe("runSynth — happy path (injected MockSynthesizer, temp git repo)", () => {
  it("writes changeset.json, validation.ok, execReport present, dry-run, repo NOT mutated", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      // EXEC_HOME lives outside the git repo so .executive/ doesn't pollute
      // the working tree (which would make isWorkingTreeClean return false).
      mkdirSync(EXEC_HOME, { recursive: true });
      setExecutiveHome(EXEC_HOME);
      const proposal = makeProposal();
      const dirProposals = proposalsDir();
      mkdirSync(dirProposals, { recursive: true });
      writeFileSync(proposalPath(), JSON.stringify(proposal, null, 2) + "\n");

      // Create a file so selectedFiles is non-empty, and commit it so the
      // working tree starts clean (untracked files would fail the
      // isWorkingTreeClean assertion regardless of runSynth's behavior).
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "main.ts"), "console.log('hello');");
      git.stageAll(dir);
      git.commit(dir, "add src/main.ts");

      const config = makeConfig();
      return runSynth({
        repoRoot: dir,
        config,
        explicitFiles: ["src/main.ts"],
        synthOverride: new MockSynthesizer(),
      }).then((report) => {
        expect(report.ok).toBe(true);
        expect(report.proposalId).toBe(proposal.id);
        expect(report.synthesizer).toBe("mock");
        expect(report.changeSetWritten).toBe(true);
        expect(existsSync(changeSetPath())).toBe(true);

        const cs = JSON.parse(readFileSync(changeSetPath(), "utf-8"));
        expect(cs.id).toBe("synth-fix_tests");

        expect(report.validation.ok).toBe(true);
        expect(report.execReport).not.toBeNull();
        expect(report.execReport!.mode).toBe("dry-run");
        expect(report.execReport!.ok).toBe(true);

        // Repo NOT mutated: no executive/change-* branch
        expect(git.branchExists(dir, "executive/change-synth-fix_tests")).toBe(false);
        // Working tree still clean
        expect(git.isWorkingTreeClean(dir)).toBe(true);

        clean();
      });
    } catch (err) {
      clean();
      throw err;
    }
  });
});

// ─── 8. runSynth — no proposal ────────────────────────────────────────────────

describe("runSynth — no proposal", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("returns ok:false, message mentions 'no proposal', nothing written", () => {
    // No proposal file created
    const config = makeConfig();
    return runSynth({
      repoRoot: TEST_DIR,
      config,
      synthOverride: new MockSynthesizer(),
    }).then((report) => {
      expect(report.ok).toBe(false);
      expect(report.proposalId).toBeNull();
      expect(report.messages.some((m) => m.includes("no proposal"))).toBe(true);
      expect(existsSync(changeSetPath())).toBe(false);
    });
  });
});

// ─── 9. runSynth — synthesizer throws ─────────────────────────────────────────

describe("runSynth — synthesizer throws", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("injected synth that throws → ok:false, error set, no changeset.json", () => {
    const dir = TEST_DIR;
    const proposal = makeProposal();
    const dirProposals = proposalsDir();
    mkdirSync(dirProposals, { recursive: true });
    writeFileSync(proposalPath(), JSON.stringify(proposal, null, 2) + "\n");

    const failingSynth: Synthesizer = {
      name: "failing",
      synthesize: async (): Promise<SynthResult> => {
        throw new Error("network timeout");
      },
    };

    const config = makeConfig();
    return runSynth({
      repoRoot: dir,
      config,
      synthOverride: failingSynth,
    }).then((report) => {
      expect(report.ok).toBe(false);
      expect(report.error).toBe("network timeout");
      expect(report.synthesizer).toBe("failing");
      expect(report.changeSetWritten).toBe(false);
      expect(existsSync(changeSetPath())).toBe(false);
    });
  });
});

// ─── 10. runSynth — unsafe ChangeSet rejected ─────────────────────────────────

describe("runSynth — unsafe ChangeSet rejected", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("injected synth returns ../escape path → validation fails, execReport null, ok:false", () => {
    const dir = TEST_DIR;
    const proposal = makeProposal();
    const dirProposals = proposalsDir();
    mkdirSync(dirProposals, { recursive: true });
    writeFileSync(proposalPath(), JSON.stringify(proposal, null, 2) + "\n");

    const unsafeCs: ChangeSet = {
      id: "unsafe-1",
      title: "unsafe",
      ops: [{ op: "write", path: "../../../escape.txt", content: "x" }],
      test: null,
      commitMessage: "unsafe",
    };

    const unsafeSynth: Synthesizer = {
      name: "unsafe",
      synthesize: async (): Promise<SynthResult> => ({
        changeSet: unsafeCs,
        raw: JSON.stringify(unsafeCs),
        backend: "unsafe",
      }),
    };

    const config = makeConfig();
    return runSynth({
      repoRoot: dir,
      config,
      synthOverride: unsafeSynth,
    }).then((report) => {
      expect(report.ok).toBe(false);
      expect(report.validation.ok).toBe(false);
      expect(report.validation.errors.length).toBeGreaterThan(0);
      expect(report.execReport).toBeNull();
      expect(report.changeSetWritten).toBe(true); // still written for inspection
    });
  });

  it("absolute path is rejected", () => {
    const dir = TEST_DIR;
    const proposal = makeProposal();
    const dirProposals = proposalsDir();
    mkdirSync(dirProposals, { recursive: true });
    writeFileSync(proposalPath(), JSON.stringify(proposal, null, 2) + "\n");

    const absCs: ChangeSet = {
      id: "abs-1",
      title: "absolute",
      ops: [{ op: "write", path: "/etc/passwd", content: "x" }],
      test: null,
      commitMessage: "abs",
    };

    const absSynth: Synthesizer = {
      name: "abs",
      synthesize: async (): Promise<SynthResult> => ({
        changeSet: absCs,
        raw: JSON.stringify(absCs),
        backend: "abs",
      }),
    };

    const config = makeConfig();
    return runSynth({
      repoRoot: dir,
      config,
      synthOverride: absSynth,
    }).then((report) => {
      expect(report.ok).toBe(false);
      expect(report.validation.ok).toBe(false);
    });
  });

  it(".git/ path is rejected", () => {
    const dir = TEST_DIR;
    const proposal = makeProposal();
    const dirProposals = proposalsDir();
    mkdirSync(dirProposals, { recursive: true });
    writeFileSync(proposalPath(), JSON.stringify(proposal, null, 2) + "\n");

    const gitCs: ChangeSet = {
      id: "git-1",
      title: "git",
      ops: [{ op: "write", path: ".git/config", content: "x" }],
      test: null,
      commitMessage: "git",
    };

    const gitSynth: Synthesizer = {
      name: "git",
      synthesize: async (): Promise<SynthResult> => ({
        changeSet: gitCs,
        raw: JSON.stringify(gitCs),
        backend: "git",
      }),
    };

    const config = makeConfig();
    return runSynth({
      repoRoot: dir,
      config,
      synthOverride: gitSynth,
    }).then((report) => {
      expect(report.ok).toBe(false);
      expect(report.validation.ok).toBe(false);
    });
  });

  it(".executive/ path is rejected", () => {
    const dir = TEST_DIR;
    const proposal = makeProposal();
    const dirProposals = proposalsDir();
    mkdirSync(dirProposals, { recursive: true });
    writeFileSync(proposalPath(), JSON.stringify(proposal, null, 2) + "\n");

    const execCs: ChangeSet = {
      id: "exec-1",
      title: "exec",
      ops: [{ op: "write", path: ".executive/state.json", content: "x" }],
      test: null,
      commitMessage: "exec",
    };

    const execSynth: Synthesizer = {
      name: "exec",
      synthesize: async (): Promise<SynthResult> => ({
        changeSet: execCs,
        raw: JSON.stringify(execCs),
        backend: "exec",
      }),
    };

    const config = makeConfig();
    return runSynth({
      repoRoot: dir,
      config,
      synthOverride: execSynth,
    }).then((report) => {
      expect(report.ok).toBe(false);
      expect(report.validation.ok).toBe(false);
    });
  });
});

// ─── 11. runSynth never applies (dry-run only) ────────────────────────────────

describe("runSynth — never applies", () => {
  it("happy path: no branch created, working tree clean (dry-run verified)", () => {
    const { dir, cleanup: clean } = createTempGitRepo();
    try {
      // EXEC_HOME lives outside the git repo so .executive/ doesn't pollute
      // the working tree (which would make isWorkingTreeClean return false).
      mkdirSync(EXEC_HOME, { recursive: true });
      setExecutiveHome(EXEC_HOME);
      const proposal = makeProposal();
      const dirProposals = proposalsDir();
      mkdirSync(dirProposals, { recursive: true });
      writeFileSync(proposalPath(), JSON.stringify(proposal, null, 2) + "\n");

      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "main.ts"), "console.log('hello');");
      git.stageAll(dir);
      git.commit(dir, "add src/main.ts");

      const config = makeConfig();
      return runSynth({
        repoRoot: dir,
        config,
        explicitFiles: ["src/main.ts"],
        synthOverride: new MockSynthesizer(),
      }).then((report) => {
        expect(report.ok).toBe(true);
        // No executive/change-* branch exists
        expect(git.branchExists(dir, "executive/change-synth-fix_tests")).toBe(false);
        // Working tree is clean
        expect(git.isWorkingTreeClean(dir)).toBe(true);
        // Original branch is still main
        expect(git.currentBranch(dir)).toBe("main");
        clean();
      });
    } catch (err) {
      clean();
      throw err;
    }
  });
});

// ─── 12. Proposal with status !== "ok" ────────────────────────────────────────

describe("runSynth — non-ok proposal", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("status 'error' → ok:false, message mentions status", () => {
    const dir = TEST_DIR;
    const proposal = makeProposal({ status: "error", summary: "error: network timeout", steps: [], raw: "", error: "network timeout" });
    const dirProposals = proposalsDir();
    mkdirSync(dirProposals, { recursive: true });
    writeFileSync(proposalPath(), JSON.stringify(proposal, null, 2) + "\n");

    const config = makeConfig();
    return runSynth({
      repoRoot: dir,
      config,
      synthOverride: new MockSynthesizer(),
    }).then((report) => {
      expect(report.ok).toBe(false);
      expect(report.messages.some((m) => m.includes("no actionable steps"))).toBe(true);
      expect(report.changeSetWritten).toBe(false);
    });
  });
});

// ─── 13. createSynthesizer selects backend ─────────────────────────────────────

describe("createSynthesizer — backend selection", () => {
  it("backend 'mock' returns a synthesizer with name 'mock'", () => {
    const cfg = makeConfig({ worker: { backend: "mock" } });
    const s = createSynthesizer(cfg);
    expect(s.name).toBe("mock");
  });

  it("backend 'anthropic' returns a synthesizer with name 'anthropic:<model>'", () => {
    const cfg = makeConfig({
      worker: {
        backend: "anthropic",
        model: "x",
        baseUrl: "https://example.com",
        apiKeyEnv: "",
        maxTokens: 512,
        timeoutMs: 10000,
        autoInvoke: false,
      },
    });
    const s = createSynthesizer(cfg);
    expect(s.name).toBe("anthropic:x");
  });
});

// ─── 14. writeChangeSet / writeSynthReport atomic ─────────────────────────────

describe("writeChangeSet / writeSynthReport — atomic persistence", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("writeChangeSet writes changeset.json that parses back", () => {
    const cs: ChangeSet = {
      id: "atomic-1",
      title: "atomic test",
      ops: [{ op: "write", path: "x.md", content: "hello" }],
      test: null,
      commitMessage: "atomic",
    };
    writeChangeSet(cs);
    expect(existsSync(changeSetPath())).toBe(true);
    const parsed = JSON.parse(readFileSync(changeSetPath(), "utf-8"));
    expect(parsed.id).toBe("atomic-1");
  });

  it("writeSynthReport writes synth-report.json that parses back", () => {
    const report = {
      ok: true,
      proposalId: "p1",
      synthesizer: "mock",
      selectedFiles: ["a.ts"],
      changeSetWritten: true,
      validation: { ok: true, errors: [] },
      execReport: null,
      messages: ["test"],
      error: null,
      generatedAt: new Date().toISOString(),
    };
    writeSynthReport(report);
    expect(existsSync(synthReportPath())).toBe(true);
    const parsed = JSON.parse(readFileSync(synthReportPath(), "utf-8"));
    expect(parsed.ok).toBe(true);
  });
});

// ─── 15. MaxFiles cap ─────────────────────────────────────────────────────────

describe("runSynth — maxFiles cap", () => {
  beforeEach(() => setExecutiveHome(TEST_DIR));
  afterEach(() => cleanup(TEST_DIR));

  it("caps selectedFiles to config.synth.maxFiles", () => {
    const dir = TEST_DIR;
    const proposal = makeProposal();
    const dirProposals = proposalsDir();
    mkdirSync(dirProposals, { recursive: true });
    writeFileSync(proposalPath(), JSON.stringify(proposal, null, 2) + "\n");

    // Create 5 files
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      const name = "file" + i + ".ts";
      writeFileSync(join(dir, name), "content");
      files.push(name);
    }

    const config = makeConfig({ synth: { maxFileBytes: 100000, maxFiles: 2 } });
    return runSynth({
      repoRoot: dir,
      config,
      explicitFiles: files,
      synthOverride: new MockSynthesizer(),
    }).then((report) => {
      expect(report.selectedFiles.length).toBe(2);
      expect(report.selectedFiles).toEqual(["file0.ts", "file1.ts"]);
    });
  });
});

// ─── 16. MockSynthesizer ChangeSet is deterministic ───────────────────────────

describe("MockSynthesizer — deterministic ChangeSet structure", () => {
  it("id is synth-<actionKind>", () => {
    const synth = new MockSynthesizer();
    const input: SynthInput = {
      proposal: makeProposal({ action: { kind: "resolve_block", reason: "r", priority: 90, confidence: 0.8, forbidden: false, disposition: "act" } }),
      summary: "test",
      files: [],
    };
    return synth.synthesize(input).then((result) => {
      expect(result.changeSet.id).toBe("synth-resolve_block");
    });
  });

  it("title is 'synthesized: <summary>'", () => {
    const synth = new MockSynthesizer();
    const input: SynthInput = {
      proposal: makeProposal({ summary: "fix the login bug" }),
      summary: "fix the login bug",
      files: [],
    };
    return synth.synthesize(input).then((result) => {
      expect(result.changeSet.title).toBe("synthesized: fix the login bug");
    });
  });

  it("raw is JSON.stringify of the ChangeSet", () => {
    const synth = new MockSynthesizer();
    const input: SynthInput = {
      proposal: makeProposal(),
      summary: "test",
      files: [],
    };
    return synth.synthesize(input).then((result) => {
      expect(result.raw).toBe(JSON.stringify(result.changeSet));
    });
  });
});
