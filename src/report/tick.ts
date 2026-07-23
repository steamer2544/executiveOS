// Digest tick — one shared "refresh the digest, log what changed" step (Phase 33).
//
// Phase 12 wired this into the `watch` daemon and Phase 14 made it durable, but the
// logic lived inline in `case "watch"`, so the `ui` command — which also runs the
// watchers and is the normal way to use the system — refreshed neither `digest.md`
// nor `notifications.jsonl`. The durable notification log was effectively dead in
// the mode the owner actually runs.
//
// Extracting it here gives both callers one implementation and makes the transition
// rules testable without a daemon. Deterministic, read-only apart from its own two
// output files: NO LLM, no git, no network — it never acts on anything it reports.

import { buildDigest, renderDigest, writeDigest, needsYouSignature } from "./digest.js";
import { diffNeedsYou, appendNotifications, type NotificationRecord } from "./notify.js";
import type { Digest, NeedsYouItem } from "./types.js";

/** Carried by the caller across ticks. `lastSignature: null` means "never ticked". */
export interface DigestTickState {
  lastSignature: string | null;
  lastItems: NeedsYouItem[];
}

export function createDigestTickState(): DigestTickState {
  return { lastSignature: null, lastItems: [] };
}

export interface DigestTickResult {
  digest: Digest;
  /** The needs-you queue differs from the previous tick. */
  changed: boolean;
  /** Items that entered the queue this tick (already logged). */
  added: NeedsYouItem[];
  /** Items that left the queue this tick (already logged). */
  resolved: NeedsYouItem[];
  /** A non-empty queue became empty. False on the very first tick, which has no
   *  "previous" queue to have emptied — printing "cleared" there would be a lie. */
  cleared: boolean;
}

/**
 * Rebuild the digest, persist `digest.md`, append a durable record for every
 * needs-you transition, and advance `st` in place.
 *
 * Only a *change* in the queue writes notifications, so a daemon ticking every 30s
 * does not spam the log. I/O errors propagate — callers wrap this in a try/catch so
 * a transient failure never kills the daemon.
 */
export function runDigestTick(st: DigestTickState): DigestTickResult {
  const digest = buildDigest();
  writeDigest(renderDigest(digest));

  const signature = needsYouSignature(digest.needsYou);
  if (signature === st.lastSignature) {
    return { digest, changed: false, added: [], resolved: [], cleared: false };
  }

  const firstTick = st.lastSignature === null;
  const cleared = !firstTick && digest.needsYou.length === 0;

  const { added, removed } = diffNeedsYou(st.lastItems, digest.needsYou);
  const ts = new Date().toISOString();
  const records: NotificationRecord[] = [
    ...added.map((i) => ({ ts, event: "added" as const, source: i.source, summary: i.summary, detail: i.detail })),
    ...removed.map((i) => ({ ts, event: "resolved" as const, source: i.source, summary: i.summary, detail: i.detail })),
  ];
  appendNotifications(records);

  st.lastSignature = signature;
  st.lastItems = digest.needsYou;

  return { digest, changed: true, added, resolved: removed, cleared };
}
