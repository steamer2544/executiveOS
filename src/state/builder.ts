// State Builder — derive state.json and context.json from event logs.
//
// 100% rule-based. No decision-making, no LLM.
// Reads JSONL event logs, walks events in seq order, derives a compact snapshot.

import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { renameOverwrite } from "../fs-atomic.js";
import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecEvent, EventSource } from "../events/types.js";
import { execRoot, statePath, contextPath } from "../paths.js";
import { readSync } from "../events/store.js";
import { loadConfig, type Config } from "../config.js";
import {
  type State,
  type Context,
  type CommitInfo,
  IDLE_THRESHOLD_MS,
  RECENT_EVENTS,
} from "./types.js";
import { computePatterns } from "./patterns.js";

// ─── Decay / TTL (Phase 39) ──────────────────────────────────────────────────
//
// "Newest event wins per field" has no expiry, so a manually-asserted signal that
// is never explicitly retired dominates the derived state forever. Two real
// incidents: a system.blocked (seq 4838) never followed by unblocked, and a stale
// system.task (seq 4985) overriding the branch-derived task — both had to be cleared
// by hand. These TTLs age out ONLY the manually-asserted state signals (blocked /
// manual task+project); auto-sensed fields (branch, file, commit, repo, window,
// tests) are refreshed continuously by watchers, so they never decay. Decay is not
// deletion: task/project fall back to branch/repo inference (itself always fresh).
//
// blocked and task/project decay UNCONDITIONALLY — they ARE transient state. `deadline`
// is different: it is a *commitment*, not a transient state (it does not resolve by
// being ignored), so retiring an overdue one silently undoes Phase 32's deliberate
// "close it out, reschedule, or clear it" nag. Deadline decay is therefore OPT-IN and
// DEFAULT OFF (`config.state.deadlineDecayDays`, a dashboard toggle) — the owner turns
// it on deliberately when they'd rather have overdue deadlines self-retire than nag.

/** A `system.blocked` with no newer `unblocked` older than this decays to not-blocked.
 *  24h — "a day-old block stops dominating". */
export const BLOCKED_TTL_MS = 24 * 60 * 60 * 1000;

/** A manual `system.task` task/project assertion older than this decays, falling back to
 *  the Phase-15/16 branch/repo inference. 72h (3 days) — honours "a task can span days"
 *  (Phase 30) while retiring a genuinely abandoned label. */
export const MANUAL_TASK_TTL_MS = 72 * 60 * 60 * 1000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days `deadline` is past `nowIso`, or null when either is not a plain YYYY-MM-DD
 *  date. Local copy of the Planner's `daysOverdue` — state sits BELOW the planner in the
 *  layer graph, so it must not import from it. A non-date deadline never decays. */
function daysPastDue(deadline: string, nowIso: string): number | null {
  if (!DATE_ONLY.test(deadline)) return null;
  const today = nowIso.slice(0, 10);
  if (!DATE_ONLY.test(today)) return null;
  const ms = Date.parse(today + "T00:00:00Z") - Date.parse(deadline + "T00:00:00Z");
  if (Number.isNaN(ms)) return null;
  const days = Math.floor(ms / 86_400_000);
  return days > 0 ? days : null;
}

/** True if a signal timestamped `ts` is older than `ttlMs` relative to `nowMs`.
 *  Uncertain (unparseable ts) → false → KEEP (never drop on doubt). */
function isStale(ts: string | null, nowMs: number, ttlMs: number): boolean {
  if (ts === null) return false;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return false;
  return nowMs - t > ttlMs;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Safely extract a string field from data, or return undefined. */
function str(data: Record<string, unknown>, key: string): string | undefined {
  return typeof data[key] === "string" ? data[key] : undefined;
}

/** Branch names that are not a "task" (you are not working on a ticket by being on main). */
const DEFAULT_BRANCHES = new Set([
  "main", "master", "develop", "dev", "trunk", "release", "staging", "prod", "production",
]);

/** Leading branch segments that are a type prefix, not part of the task name. */
const BRANCH_TYPE_PREFIXES = new Set([
  "feature", "feat", "fix", "bugfix", "hotfix", "chore", "wip", "task",
  "story", "spike", "refactor", "test", "docs",
]);

/**
 * Infer a human-readable task name from a git branch, or null when there's nothing
 * meaningful (default branch, empty). Deterministic — no LLM.
 * e.g. "feat/login-page" → "login page"; "fix/JIRA-12-null-crash" → "JIRA-12 null crash";
 *      "main" → null; "experiment" → "experiment".
 */
export function taskFromBranch(branch: string | null): string | null {
  if (!branch) return null;
  const raw = branch.trim();
  if (raw === "" || DEFAULT_BRANCHES.has(raw.toLowerCase())) return null;

  // Strip a leading type prefix ("feat/…", "fix/…") but keep deeper segments.
  let rest = raw;
  const slash = rest.indexOf("/");
  if (slash >= 0 && BRANCH_TYPE_PREFIXES.has(rest.slice(0, slash).toLowerCase())) {
    rest = rest.slice(slash + 1);
  }

  const human = rest.replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
  return human.length > 0 ? human : null;
}

/** Candidate roots an editor.save path may be relative to.
 *
 *  CRITICAL: the FsWatcher watches `<repo>/src` by default (buildWatchers uses
 *  `entry.filePaths ?? [entry.path + "/src"]` and legacy `fs.paths ?? [cwd + "/src"]`),
 *  so fs.watch records paths relative to THAT dir (e.g. "synth/foo.ts", not
 *  "src/synth/foo.ts"). Resolving only against the repo root therefore misses every
 *  real file. We must resolve against the actual watched dirs, plus repo roots and
 *  cwd (+ their /src) as fallbacks. Broad roots bias toward keeping (the intended
 *  side; a same-named collision is far rarer than dropping a real current file). */
function fileResolutionRoots(config: {
  watch?: {
    repos?: Array<{ path?: string; filePaths?: string[] } | null> | null;
    fs?: { paths?: string[] };
  };
}): string[] {
  const roots = new Set<string>();
  const add = (r?: string) => { if (r) roots.add(r); };
  const repos = config.watch?.repos;
  if (repos && repos.length > 0) {
    for (const e of repos) {
      if (!e || typeof e.path !== "string") continue;
      const watched = e.filePaths ?? [e.path + "/src"];
      for (const w of watched) add(w);
      add(e.path);
    }
  } else if (config.watch?.fs) {
    const watched = config.watch.fs.paths ?? [process.cwd() + "/src"];
    for (const w of watched) add(w);
  }
  add(process.cwd());
  add(process.cwd() + "/src");
  return [...roots];
}

/** True if `fp` resolves to an existing regular FILE (not a directory). ENOENT or
 *  unreadable → false. A directory is never a valid `currentFile`. */
function isExistingFile(fp: string): boolean {
  try {
    return statSync(fp).isFile();
  } catch {
    return false;
  }
}

/** True if `p` (an editor.save path, relative to a watched dir) is an existing file
 *  under any candidate root. Defensive: an unexpected throw → keep (bias toward
 *  keeping, never throw). Directories and vanished temp paths are dropped. */
function fileStillExists(p: string, roots: string[]): boolean {
  try {
    if (isAbsolute(p)) return isExistingFile(p);
    for (const root of roots) {
      if (isExistingFile(resolve(root, p))) return true;
    }
    return false;
  } catch {
    return true; // uncertain → keep
  }
}

// ─── readEventsSync ─────────────────────────────────────────────────────────

/** Read all events from one source synchronously, via the active backend. */
function readEventsSync(source: EventSource): ExecEvent[] {
  return readSync(source);
}

// ─── buildState ─────────────────────────────────────────────────────────────

/**
 * Build a State + Context from the event logs.
 * Pure & deterministic: reads events, derives state, does NOT write files.
 * @param now - optional clock for testing (defaults to Date.now())
 */
export function buildState(now?: Date): { state: State; context: Context } {
  const clock = now ?? new Date();
  const generatedAt = clock.toISOString();

  // Gather all events from all sources, sorted ascending by seq (tie-break ts).
  const allEvents: ExecEvent[] = [];
  const sources: EventSource[] = ["git", "terminal", "editor", "system", "screen"];
  for (const src of sources) {
    try {
      const events = readEventsSync(src);
      allEvents.push(...events);
    } catch {
      // Source log missing or unreadable — skip silently.
    }
  }

  // Sort ascending by seq, ts as tie-break.
  allEvents.sort((a, b) => a.seq - b.seq || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const eventCount = allEvents.length;
  const lastEvent = allEvents.length > 0 ? allEvents[allEvents.length - 1] : null;
  const lastEventTs = lastEvent ? lastEvent.ts : null;

  // ── Derive each field by finding the newest (highest seq) relevant event ─

  // --- currentProject, currentTask, deadline (system.task) ---
  let currentProject: string | null = null;
  let currentTask: string | null = null;
  let deadline: string | null = null;
  // ts of the event that last SET each field to a non-null value (for TTL decay below).
  let taskEventTs: string | null = null;
  let projectEventTs: string | null = null;
  for (const e of allEvents) {
    if (e.type === "system.task") {
      const d = e.data ?? {};
      // project: absent → unchanged; non-empty → set; empty/whitespace → clear (null)
      if ("project" in d) {
        const v = typeof d.project === "string" ? d.project.trim() : "";
        currentProject = v.length > 0 ? v : null;
        projectEventTs = v.length > 0 ? e.ts : null;
      }
      // task: absent → unchanged; non-empty → set; empty/whitespace → clear (null)
      if ("task" in d) {
        const v = typeof d.task === "string" ? d.task.trim() : "";
        currentTask = v.length > 0 ? v : null;
        taskEventTs = v.length > 0 ? e.ts : null;
      }
      // deadline: absent → unchanged; non-empty → set; empty/whitespace → clear (null).
      // Same three-way rule as task/project — without it a past deadline can never be
      // retired, so the Planner asks about it forever.
      if ("deadline" in d) {
        const v = typeof d.deadline === "string" ? d.deadline.trim() : "";
        deadline = v.length > 0 ? v : null;
      }
    }
  }

  // Decay stale MANUAL task/project (Phase 39) so a day-old label stops overriding
  // reality. Cleared BEFORE the branch/repo inference fallbacks below, so a decayed
  // manual value falls through to the continuously-sensed derivation.
  // Config drives the (opt-in) deadline decay and the file-resolution roots below.
  // loadConfig() throws if .executive/ isn't bootstrapped (e.g. tests) → degrade to none.
  let cfg: Config | null = null;
  try { cfg = loadConfig(); } catch { cfg = null; }

  const nowMsForDecay = clock.getTime();
  if (isStale(taskEventTs, nowMsForDecay, MANUAL_TASK_TTL_MS)) currentTask = null;
  if (isStale(projectEventTs, nowMsForDecay, MANUAL_TASK_TTL_MS)) currentProject = null;
  // Deadline decay is OPT-IN (config.state.deadlineDecayDays, default off): retire a
  // deadline only once it is more than N whole days past due, and only when the owner
  // enabled it (see the NOTE at the top of this file).
  const decayDays = cfg?.state?.deadlineDecayDays;
  if (deadline !== null && typeof decayDays === "number" && decayDays > 0) {
    const over = daysPastDue(deadline, generatedAt);
    if (over !== null && over > decayDays) deadline = null;
  }

  // --- currentFile, recentFiles (editor.save) ---
  // Only include files that still exist on disk, resolved against the dirs the
  // FsWatcher actually watches (see fileResolutionRoots). loadConfig() may throw
  // if .executive/ hasn't been bootstrapped (e.g. in tests) — fall back to cwd-only.
  const fileRoots = fileResolutionRoots(cfg ?? {});
  let currentFile: string | null = null;
  const recentFilesSet: string[] = [];
  // Walk newest → oldest to collect distinct paths
  for (let i = allEvents.length - 1; i >= 0; i--) {
    const e = allEvents[i]!;
    if (e.type === "editor.save") {
      const p = str(e.data ?? {}, "path");
      if (p && !recentFilesSet.includes(p) && fileStillExists(p, fileRoots)) {
        recentFilesSet.push(p);
        if (currentFile === null) currentFile = p;
      }
    }
  }
  const recentFiles = recentFilesSet.slice(0, 5);

  // ── Multi-repo derivation ──────────────────────────────────────────────

  // Per-repo record shape (mirrors CommitInfo but scoped per repo).
  type PerRepoCommit = Pick<CommitInfo, "sha" | "subject" | "ts">;

  interface PerRepo {
    branch: string | null;
    latestBranchSwitchSeq: number;
    latestBranchSwitchTo: string | null;
    latestCommitBranchSeq: number;
    latestCommitBranch: string | null;
    latestCommitSeq: number;
    latestCommit: PerRepoCommit | null;
    latestActivitySeq: number;
    latestActivityTs: string | null;
  }

  const repoMap = new Map<string, PerRepo>();

  function getRepo(name: string): PerRepo {
    let r = repoMap.get(name);
    if (!r) {
      r = {
        branch: null,
        latestBranchSwitchSeq: -1,
        latestBranchSwitchTo: null,
        latestCommitBranchSeq: -1,
        latestCommitBranch: null,
        latestCommitSeq: -1,
        latestCommit: null,
        latestActivitySeq: -1,
        latestActivityTs: null,
      };
      repoMap.set(name, r);
    }
    return r;
  }

  // Walk all events in seq order; group repo-tagged events by repo.
  for (const e of allEvents) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const isRepoTagged =
      (e.type === "git.commit" || e.type === "git.branch_switch" || e.type === "editor.save") &&
      typeof d.repo === "string" &&
      d.repo.length > 0;
    if (!isRepoTagged) continue;

    const repoName = d.repo as string;
    const r = getRepo(repoName);

    // Track latest activity (highest-seq event for this repo).
    if (e.seq > r.latestActivitySeq) {
      r.latestActivitySeq = e.seq;
      r.latestActivityTs = e.ts;
    }

    if (e.type === "git.branch_switch") {
      const to = str(e.data ?? {}, "to");
      if (to && e.seq > r.latestBranchSwitchSeq) {
        r.latestBranchSwitchSeq = e.seq;
        r.branch = to;
      }
    }
    if (e.type === "git.commit") {
      // Mirror the per-repo branch logic: commit.branch wins over branch_switch
      // when the commit is newer (same as the top-level logic).
      const branch = str(e.data ?? {}, "branch");
      if (branch && e.seq > r.latestBranchSwitchSeq) {
        r.branch = branch;
      }
      // Track latest commit (same shape as top-level git.lastCommit).
      const sha = str(e.data ?? {}, "sha") ?? "";
      const subject = str(e.data ?? {}, "subject") ?? "";
      if (sha && e.seq > r.latestCommitSeq) {
        r.latestCommit = { sha, subject, ts: e.ts };
        r.latestCommitSeq = e.seq;
      }
    }
  }

  // activeRepo = the repo carried by the single highest-seq repo-tagged event.
  let activeRepo: string | null = null;
  for (const e of allEvents) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const isRepoTagged =
      (e.type === "git.commit" || e.type === "git.branch_switch" || e.type === "editor.save") &&
      typeof d.repo === "string" &&
      d.repo.length > 0;
    if (!isRepoTagged) continue;
    activeRepo = d.repo as string;
  }

  // Per-repo summary array, newest-activity first. Sort by latestActivitySeq
  // (monotonic, unique) — NOT by lastActivityTs, which ties when two repos have
  // events in the same millisecond and would then fall back to insertion order
  // non-deterministically. Same "highest seq wins" rule used for activeRepo.
  const repos = Array.from(repoMap.entries())
    .sort(([, a], [, b]) => b.latestActivitySeq - a.latestActivitySeq)
    .map(([name, r]) => ({
      name,
      branch: r.branch,
      lastCommit: r.latestCommit,
      lastActivityTs: r.latestActivityTs,
    }));

  // Derive top-level git fields from the active repo (coherence: Project/Branch move together).
  let gitBranch: string | null = null;
  let lastCommit: CommitInfo | null = null;

  if (activeRepo) {
    const ar = repoMap.get(activeRepo);
    if (ar) {
      gitBranch = ar.branch;
      if (ar.latestCommit) {
        lastCommit = { sha: ar.latestCommit.sha, subject: ar.latestCommit.subject, ts: ar.latestCommit.ts };
      }
    }
  }

  // Fallback: when no repo-tagged events exist (pre-multi-repo log or single-repo
  // without the repo field), derive from all events exactly as before.
  if (!activeRepo) {
    let latestBranchSwitchSeq = -1;
    let latestBranchSwitchTo: string | null = null;
    let latestCommitBranchSeq = -1;
    let latestCommitBranch: string | null = null;
    let latestCommitSeq = -1;

    for (const e of allEvents) {
      if (e.type === "git.branch_switch") {
        const d = e.data ?? {};
        const to = str(d, "to");
        if (to && e.seq > latestBranchSwitchSeq) {
          latestBranchSwitchSeq = e.seq;
          latestBranchSwitchTo = to;
        }
      }
      if (e.type === "git.commit") {
        const d = e.data ?? {};
        const branch = str(d, "branch");
        if (branch && e.seq > latestCommitBranchSeq) {
          latestCommitBranchSeq = e.seq;
          latestCommitBranch = branch;
        }
        const sha = str(d, "sha") ?? "";
        const subject = str(d, "subject") ?? "";
        if (sha && e.seq > latestCommitSeq) {
          lastCommit = { sha, subject, ts: e.ts };
          latestCommitSeq = e.seq;
        }
      }
    }
    if (latestBranchSwitchSeq >= latestCommitBranchSeq) {
      gitBranch = latestBranchSwitchTo;
    } else if (latestCommitBranchSeq > latestBranchSwitchSeq) {
      gitBranch = latestCommitBranch;
    }
  }

  // Fallback: infer the current task from the branch name when no explicit
  // system.task provided one. Explicit tasks always win; this only fills the gap
  // so switching to a `feat/xyz` branch tells the system what you're working on.
  if (currentTask === null) {
    currentTask = taskFromBranch(gitBranch);
  }

  // Fallback: infer the project from the active repo name.
  // Explicit system.task project always wins; this only fills the gap.
  if (currentProject === null) {
    currentProject = activeRepo;
  }

  // --- tests (system.test_result) ---
  let tests: "passing" | "failing" | "unknown" = "unknown";
  for (const e of allEvents) {
    if (e.type === "system.test_result") {
      const d = e.data ?? {};
      const status = str(d, "status");
      if (status === "passing") tests = "passing";
      else if (status === "failing") tests = "failing";
    }
  }

  // --- blocked / blockedReason (system.blocked / system.unblocked) ---
  let blocked = false;
  let blockedReason: string | null = null;
  let blockedEventTs: string | null = null;
  let lastBlockedSeq = -1;
  let lastUnblockedSeq = -1;
  for (const e of allEvents) {
    if (e.type === "system.blocked") {
      const d = e.data ?? {};
      const reason = str(d, "reason") ?? null;
      if (e.seq > lastBlockedSeq) {
        lastBlockedSeq = e.seq;
        blocked = true;
        blockedReason = reason;
        blockedEventTs = e.ts;
      }
    }
    if (e.type === "system.unblocked") {
      if (e.seq > lastUnblockedSeq) {
        lastUnblockedSeq = e.seq;
        blocked = false;
        blockedReason = null;
      }
    }
  }
  // The newest event between blocked and unblocked wins.
  if (lastUnblockedSeq > lastBlockedSeq) {
    blocked = false;
    blockedReason = null;
  }
  // If lastBlockedSeq > lastUnblockedSeq, blocked stays true with its reason.
  // Equal or both 0 → default false.

  // Decay a stale block (Phase 39): a system.blocked never followed by unblocked keeps
  // firing resolve_block forever; after BLOCKED_TTL_MS treat it as resolved. Only when
  // still blocked (a fresh block, or an unblock winning, already cleared it).
  if (blocked && isStale(blockedEventTs, nowMsForDecay, BLOCKED_TTL_MS)) {
    blocked = false;
    blockedReason = null;
  }

  // --- currentWindow (from screen.window events) ---
  let currentWindow: { title: string; app: string } | null = null;
  for (const e of allEvents) {
    if (e.type === "screen.window") {
      const d = e.data ?? {};
      const title = str(d, "title");
      const app = str(d, "app");
      if (title && app) {
        currentWindow = { title, app };
      }
    }
  }

  // --- activity ---
  let idleMs: number | null = null;
  let active = false;
  if (lastEventTs) {
    const lastTs = new Date(lastEventTs).getTime();
    const nowMs = clock.getTime();
    idleMs = Math.max(0, nowMs - lastTs);
    active = idleMs <= IDLE_THRESHOLD_MS;
  }

  const state: State = {
    generatedAt,
    eventCount,
    lastEventTs,
    currentProject,
    currentTask,
    deadline,
    currentFile,
    recentFiles,
    git: {
      branch: gitBranch,
      lastCommit,
    },
    tests,
    blocked,
    blockedReason,
    currentWindow,
    activity: {
      active,
      idleMs,
    },
    activeRepo,
    repos,
    // Behavioural metrics (Phase 33) — derived here so the Planner can fire on
    // patterns while keeping its "reads State only" contract.
    patterns: computePatterns(allEvents, clock.getTime(), currentFile),
  };

  // ── Build Context ──────────────────────────────────────────────────────
  const recentEvents = allEvents.slice(-RECENT_EVENTS).map((e) => ({
    seq: e.seq,
    ts: e.ts,
    source: e.source,
    type: e.type,
    data: e.data ?? {},
  }));

  const summary = buildSummary(state);

  const context: Context = {
    generatedAt,
    summary,
    state,
    recentEvents,
  };

  return { state, context };
}

/** Build a one-line human-readable summary from State. */
function buildSummary(s: State): string {
  const branch = s.git.branch || "?";
  const file = s.currentFile || "nothing";
  const task = s.currentTask || "none";
  const testStatus = s.tests;
  const blockedPart = s.blocked ? "BLOCKED: " + (s.blockedReason || "") : "not blocked";
  const activity = s.activity.active ? "active" : "idle";
  return `On branch ${branch}, editing ${file}; task: ${task}; tests ${testStatus}; ${blockedPart}; ${activity}.`;
}

// ─── writeState ─────────────────────────────────────────────────────────────

/**
 * Atomically write state.json and context.json to .executive/.
 * Writes to temp files then renames (same pattern as seq.ts).
 */
export function writeState(built: { state: State; context: Context }): void {
  const { state, context } = built;

  // Ensure .executive/ exists.
  const root = execRoot();
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }

  // Write state.json atomically.
  atomicWrite(statePath(), JSON.stringify(state, null, 2) + "\n");

  // Write context.json atomically.
  atomicWrite(contextPath(), JSON.stringify(context, null, 2) + "\n");
}

/** Write content to a temp file in the same directory, then rename. */
function atomicWrite(targetPath: string, content: string): void {
  const dir = targetPath.substring(0, targetPath.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = targetPath + "." + randomUUID();
  writeFileSync(tmpPath, content);
  renameOverwrite(tmpPath, targetPath);
}
