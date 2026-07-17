// GitWatcher — poll-based watcher for git commits and branch switches.
// Polling (not native fs hooks) is the reliable cross-platform choice,
// especially on Windows. All state lives in the closure below so multiple
// GitWatcher instances never clobber each other.

import type { EventBus } from "../bus.js";
import type { Watcher } from "./index.js";

export interface GitWatcherConfig {
  repoPath: string;
  pollMs: number;
}

/**
 * Run a git command in `repoPath`. Returns trimmed stdout on success,
 * throws on a non-zero exit. Synchronous (Bun.spawnSync) — git calls are
 * fast and the poll cadence is seconds, so blocking briefly is fine.
 */
function runGit(repoPath: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const err = new TextDecoder().decode(result.stderr).trim();
    throw new Error(
      "git " + args.join(" ") + " failed (exit " + result.exitCode + "): " + err
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

export function createGitWatcher(cfg: GitWatcherConfig): Watcher {
  const repoPath = cfg.repoPath;

  let lastSha: string | null = null;
  let lastBranch: string | null = null;
  let warned = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentBus: EventBus | null = null;

  function headSha(): string | null {
    try {
      return runGit(repoPath, ["rev-parse", "HEAD"]);
    } catch {
      return null;
    }
  }

  function branchName(): string | null {
    try {
      return runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {
      return null;
    }
  }

  function commitSubject(sha: string): string {
    try {
      return runGit(repoPath, ["log", "-1", "--format=%s", sha]);
    } catch {
      return "(unknown)";
    }
  }

  function poll(): void {
    if (!currentBus) return;
    try {
      const sha = headSha();
      const branch = branchName();

      // Not a git repo (or git failed) — warn once, keep polling.
      if (sha === null || branch === null) {
        if (!warned) {
          process.stderr.write(
            "GitWatcher: not a git repo or git failed at " + repoPath + " — will keep polling\n"
          );
          warned = true;
        }
        return;
      }
      warned = false;

      // New commit: HEAD sha changed since we last saw it. This also fires for
      // the first commit in a repo that was empty at start (lastSha === null).
      // If several commits land between polls, we emit one event for the new
      // HEAD (documented limitation for this phase).
      if (sha !== lastSha) {
        const subject = commitSubject(sha);
        currentBus.publish({
          source: "git",
          type: "git.commit",
          data: { sha, subject, branch },
        });
      }

      // Branch switch: only when we had a known previous branch.
      if (lastBranch !== null && branch !== lastBranch) {
        currentBus.publish({
          source: "git",
          type: "git.branch_switch",
          data: { from: lastBranch, to: branch },
        });
      }

      lastSha = sha;
      lastBranch = branch;
    } catch (err) {
      process.stderr.write("GitWatcher: poll error: " + (err as Error).message + "\n");
    }
  }

  return {
    name: "git",

    start(bus: EventBus): void {
      currentBus = bus;
      // Record the baseline HEAD/branch without emitting for existing state.
      lastSha = headSha();
      lastBranch = branchName();
      interval = setInterval(poll, cfg.pollMs);
    },

    stop(): void {
      // Idempotent: clear the poll interval so the process can exit cleanly.
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
      currentBus = null;
    },
  };
}
