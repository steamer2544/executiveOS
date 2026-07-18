# Scope — Phase 13: Full ask-queue in "Needs you" (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

The Digest (Phase 11) has a **"Needs you"** section — the owner's queue of things the system will NOT do
autonomously and needs a human decision on. It is the single most valuable part of the digest, and the
`watch` daemon now alerts on it (Phase 12).

**But it currently has a correctness gap.** The "Needs you" aggregation looks at the Planner's
**`topAction` only**. The Planner (Phase 4) fires an ordered list of actions by priority; the top one wins
the "Recommended action", but lower-priority actions can also have `disposition: "ask"`. Concretely:
when work is **both** failing-tests (`fix_tests`, `act`, priority 100) **and** blocked (`resolve_block`,
`ask`, priority 90), `topAction` is the `act` one, so the digest reports **"Nothing needs you right
now"** — even though the block genuinely needs the owner. The block is **masked**.

**Phase 13 fixes this: "Needs you" surfaces EVERY fired Planner action whose `disposition === "ask"`,
not just the top one.** So an `ask` action is never hidden behind a higher-priority `act`.

### Core principle (do not violate)

This is a tiny, surgical correctness fix inside the existing **pure, deterministic, NO-LLM** Digest layer.
It changes ONE aggregation rule in `buildDigest` and its tests. Nothing else moves.

### CRITICAL — constraints (a violation of any is a defect)

- **Only the plan → "Needs you" rule changes.** The other three "Needs you" sources (autopilot
  `needsHuman`, parked failing change, worker error) are **unchanged**. `renderDigest`, `writeDigest`,
  `needsYouSignature`, the `now`/`recommended`/`lastAutopilot` sections, and the whole `Digest` shape are
  **unchanged**.
- **Recommended action still uses `topAction`.** Do NOT change the `recommended` section — it must keep
  reporting `topAction`'s kind/disposition/confidence. Only the `needsYou` aggregation broadens.
- **Backward-compatible with a degenerate plan.** Some callers/tests write a plan with a populated
  `topAction` but an **empty `actions` array**. When `actions` is empty (or absent) the rule must **fall
  back to `[topAction]`** so a `topAction` with `disposition: "ask"` still surfaces. (This both preserves
  existing behaviour and is the robust choice for malformed input — the Digest never throws.)
- **Order + dedup preserved.** Emit the plan `ask` items in `plan.actions` order (already priority-desc
  from the Planner). Keep the existing dedup-by-`summary` (`pushIfNew`) so two identical summaries collapse
  to one.
- **Still read-only, still deterministic, still NO LLM.** No new file, no git, no network.

### Out of scope (do NOT build)

- No change to the Planner (`src/planner/*`) — the Planner already emits the full `actions` list; this
  phase just consumes more of it.
- No change to `renderDigest`'s section layout, to `needsYouSignature`, or to the `watch` daemon (they
  automatically benefit — more `ask` items → the same alert path fires).
- No new "Needs you" sources, no severity/sorting changes beyond preserving `plan.actions` order.
- No config change, no CLI change.

---

## 1. The change (`src/report/digest.ts`, inside `buildDigest`)

Replace the current plan rule (which reads `topAction` only):

```ts
  // 1. Plan: ask disposition
  if (rawPlan?.topAction && rawPlan.topAction.disposition === "ask") {
    pushIfNew({
      source: "plan",
      summary: "Planner needs your call: " + rawPlan.topAction.kind,
      detail: rawPlan.topAction.reason ?? undefined,
    });
  }
```

with a rule that reads **every fired action**:

```ts
  // 1. Plan: every fired action the Planner will NOT do autonomously (disposition "ask").
  //    Iterate the whole actions list (priority-desc), not just topAction, so a lower-priority
  //    "ask" (e.g. a block) is never masked by a higher-priority "act" top action.
  //    Fall back to [topAction] when actions is empty/absent (degenerate/malformed plan).
  const firedActions =
    rawPlan?.actions && rawPlan.actions.length > 0
      ? rawPlan.actions
      : rawPlan?.topAction
        ? [rawPlan.topAction]
        : [];
  for (const a of firedActions) {
    if (a.disposition === "ask") {
      pushIfNew({
        source: "plan",
        summary: "Planner needs your call: " + a.kind,
        detail: a.reason ?? undefined,
      });
    }
  }
```

Notes:
- `pushIfNew` (the existing dedup-by-summary helper) is reused unchanged — two `ask` actions of the same
  `kind` would collapse, but the Planner does not emit duplicate kinds, so in practice each distinct `ask`
  action gets its own line.
- The `summary`/`detail` wording is identical to today (`"Planner needs your call: " + kind`, detail =
  reason), so `needsYouSignature` and existing assertions on that string stay valid.
- Do not touch the `rawExec`/`rawProposal`/`rawAuto` blocks.

That is the entire production change. `src/report/types.ts` is unchanged.

---

## 2. Tech + constraints

- Bun (latest), TypeScript (strict). No new deps.
- **All tests OFFLINE** (seed JSON artifacts under a temp `EXECUTIVE_HOME`). No network/git/LLM.
- User-facing strings: English.

---

## 3. Files to create / edit

### Edit
- `src/report/digest.ts` — the one aggregation rule above.
- `src/report/digest.test.ts` — add tests for the new behaviour (below); keep all existing tests passing.

Do NOT edit any other file.

---

## 4. Tests (`src/report/digest.test.ts` — additions) — required, `bun test`, OFFLINE

Add at minimum:

1. **`act` top action does NOT mask a lower-priority `ask`** (the core fix): seed a `Plan` with
   `topAction = fix_tests/act` and
   `actions = [ fix_tests/act (p100), resolve_block/ask (p90) ]` →
   `digest.needsYou` contains a `source:"plan"` item
   `"Planner needs your call: resolve_block"` (detail = its reason). `recommended.topActionKind` is still
   `"fix_tests"` and `recommended.disposition` is still `"act"` (Recommended unchanged).
2. **Multiple `ask` actions all surface, in priority order:** `actions` with two `ask` actions of
   different kinds → two `source:"plan"` items in `plan.actions` order.
3. **All-`act` plan → no plan item:** `actions = [ fix_tests/act ]`, `topAction = fix_tests/act` →
   no `source:"plan"` item in `needsYou` (unchanged behaviour).
4. **Fallback when `actions` empty but `topAction` is `ask`:** `topAction = resolve_block/ask`,
   `actions = []` → still surfaces one `source:"plan"` item. (This is exactly the existing "Multiple
   needsYou items from different sources" fixture — it must still pass.)

All existing tests (186) must still pass — in particular the "Plan with ask disposition → needsYou",
"Plan with act disposition → not in needsYou", and "Multiple needsYou items from different sources" tests.
**No test may perform a network/git/LLM request.**

---

## 5. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes (strict).
- [ ] `bun test` passes — existing 186 + new tests, offline.
- [ ] **End-to-end (the real gap):** in a temp repo, `emit system system.test_result '{"status":"failing"}'`
      **and** `emit system system.blocked '{"reason":"…"}'`, then `plan`, then `report` → the **Recommended
      action** is `fix_tests (act)` **and** the **Needs you** section lists
      `Planner needs your call: resolve_block`. (Before this phase it said "Nothing needs you".)
- [ ] Clearing the block (`emit system system.unblocked`) → after `plan`, `report`'s **Needs you** no
      longer lists the `resolve_block` item.
- [ ] `renderDigest`, `writeDigest`, `needsYouSignature`, the `recommended`/`now`/`lastAutopilot` sections,
      and `src/report/types.ts` are **unchanged**; only the plan aggregation in `buildDigest` changed.
- [ ] `src/planner/*`, `src/index.ts` (watch), and all other files outside §3 are **unchanged**.
- [ ] Read-only preserved: `report`/`buildDigest` write only `.executive/digest.md`; no git/LLM/network.

---

## 6. Deliverable

A commit containing the `buildDigest` rule change + its tests, plus this doc. Do NOT commit `.executive/`
runtime data. When done, hand back for review — Claude will run every item in §5 and will NOT trust the
self-report.

---

## 7. Design notes (rationale — not extra work)

- **Why surface all `ask` actions:** the "Needs you" queue answers "what won't the system do without me?"
  Every `ask`-disposition action is, by the Planner's own guardrail, exactly that — regardless of whether
  it happened to be the single highest-priority action this tick. Showing only the top one silently drops
  real decisions (a block hidden behind a fixable test), which is the opposite of the product's purpose.
- **Why Recommended still uses `topAction`:** "Recommended action" answers a different question — "if I do
  ONE thing now, what?" That is legitimately the single top action. The two sections are intentionally
  different projections of the same plan.
- **Why the `[topAction]` fallback:** a well-formed Phase-4 plan always includes `topAction` inside
  `actions`, so iterating `actions` is a superset. The fallback only matters for degenerate/hand-written
  plans where `actions` is empty — there we still honour a `topAction` that asks, keeping the Digest
  robust and never regressing an `ask` into silence.
