// Thin git helpers via spawnSync.
// No shell — args are always an array. Throws on non-zero exit (except boolean probes).

import { spawnSync } from "node:child_process";

function git(
  repoRoot: string,
  args: string[]
): ReturnType<typeof spawnSync> {
  const res = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.error) {
    throw new Error("git " + args.join(" ") + ": " + (res.error.message || String(res.error)));
  }
  return res;
}

export function isGitRepo(repoRoot: string): boolean {
  try {
    const res = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
    return res.status === 0;
  } catch {
    return false;
  }
}

export function isWorkingTreeClean(repoRoot: string): boolean {
  try {
    const res = git(repoRoot, ["status", "--porcelain"]);
    const out = (res.stdout ?? "") as string;
    return res.status === 0 && (out === "" || out === "\n");
  } catch {
    return false;
  }
}

export function currentBranch(repoRoot: string): string {
  const res = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return ((res.stdout ?? "") as string).trim();
}

export function branchExists(repoRoot: string, name: string): boolean {
  try {
    const res = git(repoRoot, ["rev-parse", "--verify", "refs/heads/" + name]);
    return res.status === 0;
  } catch {
    return false;
  }
}

export function checkoutNewBranch(repoRoot: string, name: string): void {
  const res = git(repoRoot, ["checkout", "-b", name]);
  if (res.status !== 0) {
    throw new Error(
      "git checkout -b " + name + ": " + (res.stderr || "unknown error")
    );
  }
}

export function checkoutBranch(repoRoot: string, name: string): void {
  const res = git(repoRoot, ["checkout", name]);
  if (res.status !== 0) {
    throw new Error(
      "git checkout " + name + ": " + (res.stderr || "unknown error")
    );
  }
}

export function stageAll(repoRoot: string): void {
  const res = git(repoRoot, ["add", "-A"]);
  if (res.status !== 0) {
    throw new Error(
      "git add -A: " + (res.stderr || "unknown error")
    );
  }
}

export function commit(
  repoRoot: string,
  message: string
): string {
  const res = git(repoRoot, ["commit", "-m", message]);
  if (res.status !== 0) {
    throw new Error(
      "git commit: " + (res.stderr || "unknown error")
    );
  }
  // Return the new commit SHA
  const shaRes = git(repoRoot, ["rev-parse", "HEAD"]);
  return ((shaRes.stdout ?? "") as string).trim();
}
