// Offline tests for the git-hook installer (Phase 17).

import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPostCommitHook, installHooks, HOOK_MARKER } from "./install.js";

describe("renderPostCommitHook", () => {
  it("includes the marker, the test command, and the emit call", () => {
    const s = renderPostCommitHook("bun test", "C:/rt/src/index.ts");
    expect(s.startsWith("#!/bin/sh")).toBe(true);
    expect(s).toContain(HOOK_MARKER);
    expect(s).toContain("bun test");
    expect(s).toContain("system.test_result");
    expect(s).toContain('bun run "C:/rt/src/index.ts" emit system system.test_result');
    // emits passing on success, failing otherwise
    expect(s).toContain("STATUS=passing");
    expect(s).toContain("STATUS=failing");
  });
});

describe("installHooks", () => {
  function tempGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "hooks-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    return dir;
  }

  it("writes .git/hooks/post-commit with our content", () => {
    const repo = tempGitRepo();
    try {
      const r = installHooks({ repoRoot: repo, testCommand: "bun test", runtimeEntry: "X/src/index.ts" });
      expect(r.ok).toBe(true);
      expect(existsSync(join(repo, ".git", "hooks", "post-commit"))).toBe(true);
      const content = readFileSync(join(repo, ".git", "hooks", "post-commit"), "utf-8");
      expect(content).toContain(HOOK_MARKER);
      expect(content).toContain("bun test");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("refuses when .git is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "nogit-"));
    try {
      const r = installHooks({ repoRoot: dir, testCommand: "bun test", runtimeEntry: "X" });
      expect(r.ok).toBe(false);
      expect(r.message).toContain("not a git repository");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does NOT clobber a pre-existing non-managed hook", () => {
    const repo = tempGitRepo();
    try {
      const hookPath = join(repo, ".git", "hooks", "post-commit");
      mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
      writeFileSync(hookPath, "#!/bin/sh\necho my own hook\n");
      const r = installHooks({ repoRoot: repo, testCommand: "bun test", runtimeEntry: "X" });
      expect(r.ok).toBe(false);
      expect(r.message).toContain("not overwriting");
      // original content untouched
      expect(readFileSync(hookPath, "utf-8")).toContain("my own hook");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("overwrites a hook that IS ExecutiveOS-managed", () => {
    const repo = tempGitRepo();
    try {
      const hookPath = join(repo, ".git", "hooks", "post-commit");
      mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
      writeFileSync(hookPath, renderPostCommitHook("old cmd", "OLD"));
      const r = installHooks({ repoRoot: repo, testCommand: "new cmd", runtimeEntry: "NEW" });
      expect(r.ok).toBe(true);
      const content = readFileSync(hookPath, "utf-8");
      expect(content).toContain("new cmd");
      expect(content).not.toContain("old cmd");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
