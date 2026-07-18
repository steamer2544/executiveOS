// Git-hook installer (Phase 17): auto-emit test results after each commit.
// Deterministic, local. Writes a POSIX-sh post-commit hook that runs the
// project's test command and emits system.test_result passing/failing.

import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

/** Marker so we only ever overwrite a hook we created (never clobber the user's). */
export const HOOK_MARKER = "# ExecutiveOS-managed hook";

/**
 * Render the post-commit hook script (pure — no I/O).
 * Runs `testCommand`, then emits the pass/fail via the runtime at `runtimeEntry`.
 */
export function renderPostCommitHook(testCommand: string, runtimeEntry: string): string {
  return [
    "#!/bin/sh",
    HOOK_MARKER + " — auto-emit test results after each commit.",
    "# Delete this file to disable, or regenerate with: executive install-hooks",
    "",
    testCommand,
    "if [ $? -eq 0 ]; then STATUS=passing; else STATUS=failing; fi",
    'bun run "' + runtimeEntry + '" emit system system.test_result "{\\"status\\":\\"$STATUS\\"}" >/dev/null 2>&1 || true',
    "",
  ].join("\n");
}

export interface InstallResult {
  ok: boolean;
  path: string;      // the hook path (or "" when we couldn't resolve one)
  message: string;   // human-readable outcome
}

/**
 * Install the post-commit hook into `repoRoot/.git/hooks/`.
 * Refuses to overwrite a pre-existing hook that isn't ExecutiveOS-managed.
 */
export function installHooks(opts: {
  repoRoot: string;
  testCommand: string;
  runtimeEntry: string;
}): InstallResult {
  const gitPath = opts.repoRoot.replace(/[\\/]+$/, "") + "/.git";
  if (!existsSync(gitPath)) {
    return { ok: false, path: "", message: "not a git repository (no .git found at " + opts.repoRoot + ")" };
  }
  // Worktrees/submodules store .git as a file pointing elsewhere — not supported here.
  if (!statSync(gitPath).isDirectory()) {
    return { ok: false, path: "", message: ".git is not a directory (git worktrees/submodules are not supported by install-hooks)" };
  }

  const hooksDir = gitPath + "/hooks";
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = hooksDir + "/post-commit";

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (!existing.includes(HOOK_MARKER)) {
      return {
        ok: false,
        path: hookPath,
        message: "a post-commit hook already exists and is not ExecutiveOS-managed — not overwriting. Merge it manually or remove it, then re-run.",
      };
    }
  }

  writeFileSync(hookPath, renderPostCommitHook(opts.testCommand, opts.runtimeEntry));
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // chmod is a no-op / may fail on Windows — Git for Windows runs hooks via sh regardless.
  }

  return {
    ok: true,
    path: hookPath,
    message: "installed post-commit hook — runs `" + opts.testCommand + "` and emits the test result after each commit",
  };
}
