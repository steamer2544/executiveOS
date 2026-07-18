# Scope — Phase 12: Watch Digest (surface the digest + "Needs you" in the daemon) (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

Phase 11 added a `report` command that renders `.executive/digest.md` — a human-readable summary whose
most valuable part is the **"Needs you"** queue (things awaiting the owner's decision). But the owner has
to run `report` **by hand**. Meanwhile the `watch` daemon can run the Autopilot continuously (Phase 9),
so new "needs you" items can appear while the owner is not looking — and nothing tells them.

**Phase 12 wires the digest into the `watch` daemon:** on every rebuild tick the daemon **refreshes
`.executive/digest.md`** (a pure, read-only derivation, exactly like it already refreshes `state.json` and
`plan.json`), and prints a **concise alert only when the "Needs you" queue changes** — so the owner sees
"something now needs me" in the live daemon output, without spam.

### Core principle (do not violate)

The digest is a **pure presentation layer** (Phase 11): **100% deterministic, rule-based, NO LLM,
read-only.** This phase only **calls** the existing `buildDigest`/`renderDigest`/`writeDigest` inside the
daemon and adds a **change-detector** so the alert is quiet. It writes **no new artifact** beyond the
`digest.md` that Phase 11 already owns, calls **no LLM**, runs **no git**, and **acts on nothing**.

### CRITICAL — hard guardrails (a violation of any is a defect)

- **Read-only + no new powers.** The digest refresh reuses Phase 11's `buildDigest`/`writeDigest`
  verbatim. It must not mutate anything except `.executive/digest.md`, must not call the Worker/
  Synthesizer/Executor/Autopilot, must not run git, must not hit the network. (Do NOT add any acting
  behaviour to the daemon — Phase 9's autopilot block is the ONLY thing in `watch` that may act, and it
  is unchanged by this phase.)
- **Quiet by default — alert only on change.** Printing the whole digest every tick would be spam. The
  daemon computes a **signature of the current "Needs you" set** and prints an alert **only when that
  signature differs from the previous tick** (same dedup discipline as Phase 9's guard). An unchanged
  queue prints nothing extra.
- **Never crashes the daemon.** The whole digest step is wrapped so any error is caught, logged to
  stderr, and the daemon keeps ticking. A digest failure must never take down the watchers or the
  state/plan rebuild.
- **Ordering: digest is built LAST in the tick.** It must run **after** the autopilot block, so that when
  the Autopilot just wrote a new `auto-report.json` (e.g. parked a failing change), the refreshed digest
  and the "Needs you" alert reflect it **this same tick**.
- **The standalone `report` command is unchanged.** Phase 12 touches only the `watch` case + adds one
  pure helper. `report` behaves exactly as in Phase 11.

### Out of scope (do NOT build)

- No external delivery (email/Slack/push/webhook) — still deferred, outward-facing.
- No change to `src/report/digest.ts`'s existing functions' behaviour (you only **add** one small pure
  helper; you do NOT alter `buildDigest`/`renderDigest`/`writeDigest`).
- No edits to `src/state/*`, `src/planner/*`, `src/worker/*`, `src/executor/*`, `src/synth/*`,
  `src/auto/*`, `src/bootstrap.ts`. The Autopilot block in `watch` is unchanged.
- No SQLite, no server, no new watchers.

### Config decision (stated, not asked)

**No config gate.** The daemon already refreshes `state.json` and `plan.json` unconditionally every tick
(pure derivations); the digest is the same kind of pure derivation, so refreshing `digest.md` is
ungated and consistent. The only *new visible output* is the change-triggered "Needs you" alert, which is
already quiet by design (fires only when the queue changes). `src/config.ts` is therefore **unchanged**.

---

## 1. Data flow (added to the existing `runRebuild` tick)

```
runRebuild()  (startup + every intervalMs)          [existing]
  buildState → writeState                            [existing]
  plan → writePlan                                   [existing]
  [worker.autoInvoke block]                          [existing, unchanged]
  [autopilot block — may write auto-report.json]     [existing, unchanged]
  ── NEW: digest refresh + needs-you alert ──────────────────────────
  try:
    const digest = buildDigest();                    (Phase 11, read-only)
    writeDigest(renderDigest(digest));               (→ .executive/digest.md)
    const sig = needsYouSignature(digest.needsYou);  (NEW pure helper)
    if (sig !== lastNeedsSignature):
        if digest.needsYou.length > 0:
            print "⚠️  Needs you (" + N + "):"
            print one "   - <summary>" line per item
        else if lastNeedsSignature !== null:         (queue went non-empty → empty)
            print "✓ Needs-you queue cleared."
        lastNeedsSignature = sig
  catch err: stderr "Digest refresh failed: <msg>"   (never crash)
  ── existing "State rebuild (interval …)" line stays as-is ──
```

`lastNeedsSignature` is an **in-memory** string|null held in the `watch` case (like Phase 9's guard
state), initialised to `null` before the first tick.

---

## 2. Tech + constraints

- Bun (latest), TypeScript (strict). No new runtime deps.
- Storage: writes only `.executive/digest.md` (Phase 11's file).
- Runs on Windows 11.
- **All tests OFFLINE**: the only new unit is the pure `needsYouSignature` helper. No network, no git,
  no LLM. The daemon wiring is verified live by the reviewer (§7), not by a daemon-booting test.
- User-facing strings: English.

### Existing functions/types you MUST import read-only (do not change their behaviour)

- `buildDigest`, `renderDigest`, `writeDigest` from `src/report/digest.ts` (call as-is).
- `NeedsYouItem`, `Digest` from `src/report/types.ts`.

---

## 3. Files to create / edit

### Edit
- `src/report/digest.ts` — **add** one pure exported function `needsYouSignature(items)`. Do NOT change
  the existing functions.
- `src/report/digest.test.ts` — add unit tests for `needsYouSignature`.
- `src/index.ts` — in the `watch` case only: declare `let lastNeedsSignature: string | null = null;`
  alongside the other daemon state, and add the digest-refresh + alert block at the **end of the inner
  `try` in `runRebuild`**, after the autopilot block and before `} catch (planErr)`. Add the
  `buildDigest`/`renderDigest`/`writeDigest`/`needsYouSignature` imports.

Do NOT edit any other file.

---

## 4. The signature helper (`src/report/digest.ts` — addition only)

```ts
import type { NeedsYouItem } from "./types.js";   // (already importing from ./types)

/**
 * A stable, order-independent signature of the "Needs you" queue.
 * Two queues with the same set of {source, summary} pairs produce the same string,
 * regardless of insertion order. Used by the watch daemon to alert only on change.
 */
export function needsYouSignature(items: NeedsYouItem[]): string {
  return items
    .map((i) => i.source + "|" + i.summary)
    .sort()
    .join("\n");
}
```

- Empty queue → `""` (empty string). That is a valid, distinct signature meaning "nothing pending".
- Use `source + "|" + summary` (not `detail`) — the summary identifies the item; a changed `detail`
  alone should not re-alert.
- **Deterministic:** `sort()` makes it order-independent so a reshuffle does not falsely re-alert.

---

## 5. Daemon wiring (`src/index.ts`, `watch` case only)

1. Near the other in-memory daemon state (where `autopilotGuard` / `autopilotRunning` are declared), add:
   ```ts
   let lastNeedsSignature: string | null = null;
   ```
2. At the **end of the inner `try`** in `runRebuild` (after the autopilot `if/else`, before
   `} catch (planErr) {`), add:
   ```ts
   // ── Digest refresh + Needs-you alert (read-only; never acts) ──
   try {
     const digest = buildDigest();
     writeDigest(renderDigest(digest));
     const sig = needsYouSignature(digest.needsYou);
     if (sig !== lastNeedsSignature) {
       if (digest.needsYou.length > 0) {
         process.stdout.write("⚠️  Needs you (" + digest.needsYou.length + "):\n");
         for (const item of digest.needsYou) {
           process.stdout.write("   - " + item.summary + "\n");
         }
       } else if (lastNeedsSignature !== null) {
         process.stdout.write("✓ Needs-you queue cleared.\n");
       }
       lastNeedsSignature = sig;
     }
   } catch (digestErr) {
     process.stderr.write("Digest refresh failed: " + (digestErr as Error).message + "\n");
   }
   ```
   - Note the guard `lastNeedsSignature !== null` on the "cleared" branch: on the **very first tick** with
     an already-empty queue, `sig === ""` differs from the initial `null`, so we set
     `lastNeedsSignature = ""` **without** printing "cleared" (there was never a queue to clear). Only a
     transition from a non-empty queue to empty prints "cleared".
3. Do NOT touch the existing "State rebuild (interval …)" line, the autopilot block, the worker block, or
   the timer/SIGINT logic.

---

## 6. Tests (`src/report/digest.test.ts` — additions) — required, `bun test`, OFFLINE

Add unit tests for `needsYouSignature`. Cover at minimum:

1. **Empty queue → empty string:** `needsYouSignature([])` === `""`.
2. **Stable for same set:** two arrays with the same `{source, summary}` pairs in **different order**
   produce the **same** signature (order-independence).
3. **Changes when an item is added/removed:** adding a new item changes the signature; removing one
   changes it back.
4. **Ignores `detail`:** two items identical in `source`+`summary` but different `detail` → **same**
   signature.
5. **Distinguishes source vs summary:** same `summary` under a different `source` → **different**
   signature.

All existing tests (180) must still pass. **No test may perform a network/git/LLM request.**

> No daemon-booting test is required; the reviewer verifies the `watch` wiring live (§7).

---

## 7. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes (strict).
- [ ] `bun test` passes — existing 180 + new `needsYouSignature` tests, offline.
- [ ] In a temp repo with the daemon running (`backend: "mock"`), each tick refreshes
      `.executive/digest.md` (its content reflects the current `state.json`/`plan.json`/`auto-report.json`).
- [ ] When a "Needs you" item first appears (e.g. seed a blocked/ask state → `resolve_block` ask), the
      daemon prints a `⚠️  Needs you (N):` block **once**, and does **not** reprint it on subsequent
      ticks while the queue is unchanged (change-only alert; no spam).
- [ ] When the queue transitions from non-empty back to empty, the daemon prints `✓ Needs-you queue
      cleared.` exactly once; a queue that starts empty prints neither line.
- [ ] With the Autopilot enabled+applying and a change that parks with failing tests, the **same tick**
      that parks it also surfaces a "Needs you" alert (digest built after the autopilot block).
- [ ] The digest step never crashes the daemon: SIGINT still exits 0; a forced digest error is logged to
      stderr and ticking continues.
- [ ] `report` (standalone) behaves exactly as in Phase 11 (unchanged).
- [ ] `src/state/*`, `src/planner/*`, `src/worker/*`, `src/executor/*`, `src/synth/*`, `src/auto/*`,
      `src/config.ts`, `src/bootstrap.ts` are **unchanged**; the existing `buildDigest`/`renderDigest`/
      `writeDigest` behaviour is unchanged (only `needsYouSignature` added).
- [ ] `.executive/digest.md` stays gitignored; no runtime data committed.
- [ ] Only the files listed in §3 were created/edited.

---

## 8. Deliverable

A commit containing the `needsYouSignature` addition + its tests and the `watch`-case wiring in
`src/index.ts`, plus this doc. Do NOT commit `.executive/` runtime data. When done, hand back for review —
Claude will run every item in §7 and will NOT trust the self-report.

---

## 9. Design notes (rationale — not extra work)

- **Why ungated:** the daemon already unconditionally rebuilds `state.json` and `plan.json` each tick;
  `digest.md` is the same kind of pure, read-only projection, so refreshing it needs no opt-in. The one
  new visible behaviour — the "Needs you" alert — is self-limiting (change-only), so it does not warrant a
  config flag.
- **Why alert only on change:** a continuously-running daemon that reprinted the full queue every 30 s
  would train the owner to ignore it. Alerting on the *transition* (new item appears / queue clears) is
  the signal that actually deserves attention — the same "dedup by signature" idea Phase 9 uses to avoid
  re-acting on an unchanged state.
- **Why build the digest last in the tick:** the Autopilot may have just changed the world (parked a red
  change, stopped needing a human). Building the digest after it means the alert the owner sees is about
  *this* tick's outcome, not last tick's.
- **Why signature ignores `detail`:** `detail` is explanatory prose that can wobble (e.g. a reason string)
  without the underlying item changing. Keying on `source+summary` keeps the alert tied to *what* needs
  the owner, not incidental wording.
