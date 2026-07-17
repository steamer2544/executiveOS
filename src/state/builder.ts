// State Builder — derive state.json and context.json from event logs.
//
// 100% rule-based. No decision-making, no LLM.
// Reads JSONL event logs, walks events in seq order, derives a compact snapshot.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExecEvent, EventSource } from "../events/types.js";
import { eventLogPath, execRoot, statePath, contextPath } from "../paths.js";
import {
  type State,
  type Context,
  type CommitInfo,
  IDLE_THRESHOLD_MS,
  RECENT_EVENTS,
} from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Safely extract a string field from data, or return undefined. */
function str(data: Record<string, unknown>, key: string): string | undefined {
  return typeof data[key] === "string" ? data[key] : undefined;
}

// ─── readEventsSync ─────────────────────────────────────────────────────────

/** Read all events from one source's JSONL log synchronously. */
function readEventsSync(source: EventSource): ExecEvent[] {
  const path = eventLogPath(source);
  if (!existsSync(path)) {
    return [];
  }
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n");
  const events: ExecEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === "") continue;
    try {
      const event = JSON.parse(line) as ExecEvent;
      if (event.seq === undefined) event.seq = 0;
      events.push(event);
    } catch {
      // Skip corrupt lines — never crash the builder.
    }
  }
  return events;
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
  const sources: EventSource[] = ["git", "terminal", "editor", "system"];
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
  for (const e of allEvents) {
    if (e.type === "system.task") {
      const d = e.data ?? {};
      if (typeof d.project === "string" && (d.project as string).length > 0)
        currentProject = d.project as string;
      if (typeof d.task === "string" && (d.task as string).length > 0)
        currentTask = d.task as string;
      if (typeof d.deadline === "string" && (d.deadline as string).length > 0)
        deadline = d.deadline as string;
    }
  }

  // --- currentFile, recentFiles (editor.save) ---
  let currentFile: string | null = null;
  const recentFilesSet: string[] = [];
  // Walk newest → oldest to collect distinct paths
  for (let i = allEvents.length - 1; i >= 0; i--) {
    const e = allEvents[i]!;
    if (e.type === "editor.save") {
      const p = str(e.data ?? {}, "path");
      if (p && !recentFilesSet.includes(p)) {
        recentFilesSet.push(p);
        if (currentFile === null) currentFile = p;
      }
    }
  }
  const recentFiles = recentFilesSet.slice(0, 5);

  // --- git.lastCommit (from git.commit) ---
  let lastCommitSeq = -1;
  let lastCommit: CommitInfo | null = null;
  for (const e of allEvents) {
    if (e.type === "git.commit") {
      const d = e.data ?? {};
      const sha = str(d, "sha") ?? "";
      const subject = str(d, "subject") ?? "";
      if (sha) {
        lastCommit = { sha, subject, ts: e.ts };
        lastCommitSeq = e.seq;
      }
    }
  }

  // --- git.branch (newest of branch_switch.to / commit.branch by seq) ---
  let latestBranchSwitchSeq = -1;
  let latestBranchSwitchTo: string | null = null;
  let latestCommitBranchSeq = -1;
  let latestCommitBranch: string | null = null;
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
    }
  }
  let gitBranch: string | null = null;
  if (latestBranchSwitchSeq >= latestCommitBranchSeq) {
    gitBranch = latestBranchSwitchTo;
  } else if (latestCommitBranchSeq > latestBranchSwitchSeq) {
    gitBranch = latestCommitBranch;
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
    activity: {
      active,
      idleMs,
    },
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
 * Atomically write state.json and context.json to .executiveOS/.
 * Writes to temp files then renames (same pattern as seq.ts).
 */
export function writeState(built: { state: State; context: Context }): void {
  const { state, context } = built;

  // Ensure .executiveOS/ exists.
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
  renameSync(tmpPath, targetPath);
}
