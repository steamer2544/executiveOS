// Durable notification log — appends "Needs you" transitions (added / resolved)
// to .executive/notifications.jsonl so the owner can review them later.
// Deterministic, rule-based, NO LLM, local-only (append-only).

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import type { NeedsYouItem } from "./types.js";
import { notificationsPath, execRoot } from "../paths.js";

/** One durable notification record: a "Needs you" item appeared or was resolved. */
export interface NotificationRecord {
  ts: string;                        // ISO timestamp of the transition
  event: "added" | "resolved";       // did the item enter or leave the queue?
  source: NeedsYouItem["source"];    // "plan" | "autopilot" | "executor" | "worker"
  summary: string;
  detail?: string;
}

/** Stable key for a needs-you item (matches needsYouSignature's keying). */
function keyOf(i: NeedsYouItem): string {
  return i.source + "|" + i.summary;
}

/**
 * Diff two "Needs you" queues by {source, summary} (detail is ignored, as in needsYouSignature).
 * added   = items in curr not in prev.
 * removed = items in prev not in curr.
 * Pure — no I/O.
 */
export function diffNeedsYou(
  prev: NeedsYouItem[],
  curr: NeedsYouItem[]
): { added: NeedsYouItem[]; removed: NeedsYouItem[] } {
  const prevKeys = new Set(prev.map(keyOf));
  const currKeys = new Set(curr.map(keyOf));
  const added = curr.filter((i) => !prevKeys.has(keyOf(i)));
  const removed = prev.filter((i) => !currKeys.has(keyOf(i)));
  return { added, removed };
}

/** Append notification records to .executive/notifications.jsonl (one JSON object per line). */
export function appendNotifications(records: NotificationRecord[]): void {
  if (records.length === 0) return;
  const root = execRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(notificationsPath(), lines);
}

/**
 * Read notification records oldest→newest. Skips blank/corrupt lines (never throws).
 * Returns [] when the file does not exist.
 */
export function readNotifications(): NotificationRecord[] {
  const path = notificationsPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: NotificationRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as NotificationRecord); }
    catch { /* skip a corrupt line — never crash a read */ }
  }
  return out;
}
