// Event-log compaction (Phase 32.1).
//
// The Phase 32 filters only apply to NEW signals — the historical log still carries the
// noise they were written to stop: spinner-frame screen events, junk voice notes, and
// pending Advisor proposals that say the same thing. This rewrites those artifacts using
// the SAME pure predicates the live path uses, so past and present agree.
//
// Deterministic, no LLM, no network. Two guardrails, per the project's rules:
//   • dry-run by default — `--apply` is opt-in;
//   • every file it rewrites is copied to .executive/backup-<ts>/ first, so the whole
//     operation is reversible by copying the directory back.
//
// `seq` is never renumbered: dropping events leaves the survivors monotonic, and
// meta.json's next-seq stays ahead of them.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { renameOverwrite } from "../fs-atomic.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execRoot, eventLogPath, advisorPath } from "../paths.js";
import { normalizeTitle } from "../watchers/screen.js";
import { judgeNote } from "../capture/note.js";
import { isRepeatIntent, readStore, writeStore } from "../advisor/store.js";
import type { ExecEvent } from "../events/types.js";
import type { AdvisorStore } from "../advisor/types.js";

export interface CompactionSection {
  /** Records read. */
  before: number;
  /** Records that survive. */
  after: number;
  /** Human-readable examples of what goes (capped). */
  samples: string[];
}

export interface CompactionReport {
  mode: "dry-run" | "apply";
  screen: CompactionSection;
  notes: CompactionSection;
  advisor: CompactionSection;
  /** Where the originals were copied (apply mode only). */
  backupDir: string | null;
}

const SAMPLE_CAP = 5;

/** Read a JSONL log into events, skipping corrupt lines. Missing file → []. */
function readJsonl(path: string): ExecEvent[] {
  if (!existsSync(path)) return [];
  const out: ExecEvent[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as ExecEvent);
    } catch {
      // A corrupt line carries no signal and cannot be rewritten — drop it.
    }
  }
  return out;
}

/** Write events back as JSONL, atomically (temp + rename). No-op when there was no log
 *  to begin with — compaction must never conjure an events dir that bootstrap owns. */
function writeJsonl(path: string, events: ExecEvent[]): void {
  if (!existsSync(path)) return;
  const tmp = path + "." + randomUUID();
  writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : ""));
  renameOverwrite(tmp, path);
}

/**
 * Collapse spinner/notification-count frames in a screen log.
 * Keeps an event when its (app, normalized title) differs from the last KEPT event,
 * and rewrites the surviving titles to their normalized form — exactly what the live
 * watcher now emits. Pure.
 */
export function compactScreenEvents(events: ExecEvent[]): { kept: ExecEvent[]; dropped: ExecEvent[] } {
  const kept: ExecEvent[] = [];
  const dropped: ExecEvent[] = [];
  let lastKey: string | null = null;
  for (const e of events) {
    if (e.type !== "screen.window") {
      kept.push(e);
      continue;
    }
    const data = (e.data ?? {}) as { title?: unknown; app?: unknown };
    const rawTitle = typeof data.title === "string" ? data.title : "";
    const app = typeof data.app === "string" ? data.app : "";
    const title = normalizeTitle(rawTitle);
    const key = app + "|" + title;
    if (key === lastKey) {
      dropped.push(e);
      continue;
    }
    lastKey = key;
    kept.push({ ...e, data: { ...(e.data ?? {}), title, app } });
  }
  return { kept, dropped };
}

/**
 * Drop dictated notes that could not carry meaning, using the same gate as /api/emit.
 * Typed captures and every non-note event are untouched. Pure.
 */
export function compactNoteEvents(events: ExecEvent[]): { kept: ExecEvent[]; dropped: ExecEvent[] } {
  const kept: ExecEvent[] = [];
  const dropped: ExecEvent[] = [];
  for (const e of events) {
    const data = (e.data ?? {}) as { msg?: unknown; via?: unknown };
    const isVoiceNote = e.type === "system.note" && data.via === "voice";
    if (isVoiceNote && !judgeNote(typeof data.msg === "string" ? data.msg : "").keep) {
      dropped.push(e);
      continue;
    }
    kept.push(e);
  }
  return { kept, dropped };
}

/**
 * Retire pending Advisor proposals that repeat an earlier still-pending one.
 * Duplicates are marked `rejected` with a note rather than deleted — the record of what
 * was proposed survives, and the queue shrinks to one card per decision. Mutates `store`.
 */
export function compactAdvisorStore(
  store: AdvisorStore,
  now: string = new Date().toISOString()
): { droppedTitles: string[] } {
  const openTitles: string[] = [];
  const droppedTitles: string[] = [];
  for (const item of store.items) {
    if (item.status !== "pending") continue;
    if (isRepeatIntent(item.title, openTitles)) {
      item.status = "rejected";
      item.decidedAt = now;
      item.note = "auto-merged duplicate (compaction)";
      droppedTitles.push(item.title);
      continue;
    }
    openTitles.push(item.title);
  }
  return { droppedTitles };
}

function section(before: number, after: number, samples: string[]): CompactionSection {
  return { before, after, samples: samples.slice(0, SAMPLE_CAP) };
}

/**
 * Compact the historical artifacts. Reports what would change; only writes when
 * `apply` is true, and only after backing the originals up.
 */
export function runCompaction(opts: { apply?: boolean } = {}): CompactionReport {
  const apply = opts.apply === true;

  const screenPath = eventLogPath("screen");
  const systemPath = eventLogPath("system");
  const screenEvents = readJsonl(screenPath);
  const systemEvents = readJsonl(systemPath);

  const screenResult = compactScreenEvents(screenEvents);
  const noteResult = compactNoteEvents(systemEvents);

  const store = readStore();
  // Work on a copy so a dry-run cannot mutate anything the caller holds.
  const storeCopy: AdvisorStore = JSON.parse(JSON.stringify(store)) as AdvisorStore;
  const advisorPending = storeCopy.items.filter((i) => i.status === "pending").length;
  const advisorResult = compactAdvisorStore(storeCopy);

  const report: CompactionReport = {
    mode: apply ? "apply" : "dry-run",
    screen: section(
      screenEvents.length,
      screenResult.kept.length,
      screenResult.dropped.map((e) => String((e.data as { title?: unknown })?.title ?? ""))
    ),
    notes: section(
      systemEvents.length,
      noteResult.kept.length,
      noteResult.dropped.map((e) => String((e.data as { msg?: unknown })?.msg ?? ""))
    ),
    advisor: section(
      advisorPending,
      advisorPending - advisorResult.droppedTitles.length,
      advisorResult.droppedTitles
    ),
    backupDir: null,
  };

  if (!apply) return report;

  // Back up every file we are about to rewrite, then rewrite.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(execRoot(), "backup-" + stamp);
  mkdirSync(backupDir, { recursive: true });
  for (const src of [screenPath, systemPath, advisorPath()]) {
    if (existsSync(src)) copyFileSync(src, join(backupDir, src.split(/[\\/]/).pop()!));
  }
  report.backupDir = backupDir;

  writeJsonl(screenPath, screenResult.kept);
  writeJsonl(systemPath, noteResult.kept);
  writeStore(storeCopy);

  return report;
}
