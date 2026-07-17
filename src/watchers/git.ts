// GitWatcher — poll-based watcher for git commits and branch switches.
// Reliable cross-platform choice, especially on Windows.

import { EventBus, type EventInput } from "../bus.js";
import type { Watcher } from "./index.js";
import type { EventSource } from "../events/types.js";

export interface GitWatcherConfig {
  repoPath: string;
  pollMs: number;
}

async function runGit(args: string[]): Promise<string> {
  const result = await Bun.$({ cwd: config.repoPath })`git ${args}`;
  return String(result.stdout).trim();
}

let config: GitWatcherConfig;
let lastSha: string | null = null;
let lastBranch: string | null = null;
let warned = false;
let bus: EventBus;

async function getHeadSha(): Promise<string | null> {
  try {
    return await runGit(["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

async function getCurrentBranch(): Promise<string | null> {
  try {
    return await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return null;
  }
}

async function getCommitSubject(sha: string): Promise<string> {
  try {
    return await runGit(["log", "-1", "--format=%s", sha]);
  } catch {
    try {
      return await runGit(["log", "-1", "--format=%s"]);
    } catch {
      return "(unknown)";
    }
  }
}

async function poll(): Promise<void> {
  try {
    const sha = await getHeadSha();
    const branch = await getCurrentBranch();

    if (sha === null || branch === null) {
      if (!warned) {
        process.stderr.write("GitWatcher: not a git repo or git command failed, skipping\n");
        warned = true;
      }
      return;
    }

    // Emit on any HEAD change (including first successful poll).
    if (sha !== lastSha) {
      const subject = await getCommitSubject(sha);
      bus.publish({
        source: "git" as EventSource,
        type: "git.commit",
        data: { sha, subject, branch },
      });
    }

    // Emit on branch switch.
    if (lastBranch !== null && branch !== lastBranch) {
      bus.publish({
        source: "git" as EventSource,
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

export function createGitWatcher(cfg: GitWatcherConfig): Watcher {
  config = cfg;
  // Reset module-level state for test isolation.
  lastSha = null;
  lastBranch = null;
  warned = false;

  return {
    name: "git",

    async start(b: EventBus): Promise<void> {
      bus = b;
      // Record baseline without emitting.
      lastSha = await getHeadSha();
      lastBranch = await getCurrentBranch();
      setInterval(poll, cfg.pollMs);
    },

    stop(): void {
      // No interval reference needed — setInterval is cleared by the event loop on exit.
    },
  };
}
