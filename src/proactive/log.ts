// JSONL log for proactive nudges (Phase 36).
//
// Mirrors src/report/notify.ts exactly — same problem, same solution.
// Append-only, never rewritten in place. Defensive reads (skip corrupt lines,
// missing file → []).
//
// Path: .executive/nudges.jsonl (from nudgeLogPath in src/paths.ts).

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { nudgeLogPath, execRoot } from "../paths.js";
import type { NudgeRecord } from "./types.js";

/**
 * Append nudge records to .executive/nudges.jsonl.
 * Creates the directory if missing. Never throws.
 */
export function appendNudgeRecords(records: NudgeRecord[]): void {
  if (records.length === 0) return;
  try {
    const root = execRoot();
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    appendFileSync(nudgeLogPath(), lines);
  } catch {
    // A failed log write must never break the nudge flow.
  }
}

/**
 * Read nudge records oldest→newest.
 * Defensive: missing file → [], corrupt line → skipped, never throws.
 */
export function readNudgeRecords(): NudgeRecord[] {
  const path = nudgeLogPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const out: NudgeRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as NudgeRecord);
      } catch {
        // Skip corrupt line — never crash a read.
      }
    }
    return out;
  } catch {
    return [];
  }
}
