# Scope — Phase 39: State decay / TTL — stale manual signals age out

> **Audience:** implementer + reviewer (architect-implemented this phase). Everything needed is here.
> **Author:** Claude (architect). **Layer:** `src/state/builder.ts` only + its tests. Pure, deterministic, NO LLM.
>
> **POST-/scrutinize UPDATE, then Phase 39.1 (this session):** the `/scrutinize` flagged that
> **unconditional** deadline decay silently undoes Phase 32's deliberate "close it out, reschedule, or
> clear it" nag — a deadline is a *commitment*, not a transient state, and doesn't resolve by being
> ignored. So `blocked` and manual `task`/`project` decay **unconditionally**, but **deadline decay is now
> OPT-IN and DEFAULT OFF** — a dashboard Autonomy toggle backed by `config.state.deadlineDecayDays`
> (null/≤0 = off; a positive N = retire a deadline >N days past due; the toggle writes 7). Default off = the
> Phase 32 nag is preserved; the owner turns it on deliberately if they'd rather overdue deadlines
> self-retire. The deadline sections below describe the *enabled* behaviour.

---

## 0. What this phase is (and is NOT)

ExecutiveOS derives a compact `State` from an append-only event log with one rule: **newest event wins per
field**. Phase 30 added *clearing* (an empty `system.task` retires a task), but there is still **no expiry**:
a manual assertion that is never explicitly retired dominates the derived state **forever**.

Two real incidents on this machine (seen live, documented in `HANDOFF.md`):

1. A `system.blocked` (seq **4838**) was confirmed and then **never followed by `system.unblocked`**, so the
   Planner kept firing `resolve_block` on a day-old blocker that had long been resolved. The owner had to
   `emit system.unblocked` **by hand** to make the dashboard tell the truth.
2. A `system.task` (seq **4985**) set a task that was **stale but not cleared**, overriding the branch-derived
   task forever. The owner had to `emit` an empty `system.task` **by hand**.

Both hand-fixes are exactly what a **time-based age-out** does automatically. This phase gives the
**manually-asserted** signals — `blocked`, manual `task`/`project`, `deadline` — a deterministic TTL so a
stale one stops dominating, **falling back to the same continuously-sensed derivation** the owner would get
after clearing it.

### Reconciling with Phase 30

Phase 30's scope said *"No time-based expiry / TTL (a task can legitimately span days — do not guess staleness
from age)."* Phase 39 **narrowly reverses** that, and the reconciliation is deliberate:

- **Only *manually-asserted* signals decay** (`system.blocked`, `system.task`). Auto-sensed signals
  (`git.branch`, `currentFile`, commits, `activeRepo`, `currentWindow`, `tests`) are **continuously refreshed
  by watchers**, so "newest wins" is already correct for them and they **never decay**.
- **Decay is not deletion** — it falls back to the sensed derivation, which for `task`/`project` is the
  Phase-15/16 branch/repo inference (itself continuously fresh). If you are genuinely still on the task, the
  branch usually re-supplies it; if you have moved on, the stale label retires itself.
- **The task/project TTL is generous (3 days)** precisely to honour "a task can span days" — only a
  genuinely abandoned assertion ages out.

### CRITICAL — hard guardrails (a violation of any is a defect)

- **Deterministic, NO LLM, NO network, NO new event source, NO config change, NO CLI change.** Pure
  derivation change inside `buildState` + tests. No Planner/Worker/Executor/Synth/Advisor/infer edits.
- **Age is measured against the builder's own clock** (`buildState(now?)`), using each winning event's `ts`
  — so the function stays a pure function of (events, now). No `Date.now()` calls sprinkled around.
- **Uncertain → keep.** If a `ts` is unparseable (`Date.parse` → `NaN`), the age comparison is `false` → the
  signal is **kept**, never dropped. Never throw.
- **Decay only ever *removes* a stale positive assertion.** It can turn `blocked:true → false`, a manual
  `task/project → null` (then inference fills it), a `deadline → null`. It never invents or sets a value.

### Out of scope (do NOT build)

- No decay of auto-sensed fields (branch, file, commit, repo, window, tests).
- No config block / no CLI flag for the TTLs (constants in the builder; promote to config later if wanted).
- No "reset the log" command; history is untouched (decay is a read-time derivation, like clearing).
- No change to how the Planner phrases `resolve_block` / `review_deadline`.

---

## 1. The three TTLs (constants, exported from `src/state/builder.ts`)

| Constant | Value | Applies to | Rationale |
|---|---|---|---|
| `BLOCKED_TTL_MS` | 24 h | `system.blocked` with no newer `unblocked` | "a day-old block stops dominating" (HANDOFF). A blocker untouched for a day is almost certainly resolved or forgotten. |
| `MANUAL_TASK_TTL_MS` | 72 h (3 days) | manual `task` **and** `project` from `system.task` | Honours "a task can span days" (Phase 30) while retiring a genuinely abandoned label. Branch/repo inference is the fallback. |
| `DEADLINE_STALE_DAYS` | 7 days **past due** | `deadline` from `system.task` | A deadline is a *future commitment*, so it decays by **days past the deadline date**, NOT by the setting event's age (a future deadline set long ago must survive). Complements Phase 32: nag while freshly overdue → auto-retire when long overdue. |

---

## 2. Implementation (all inside `buildState`, `src/state/builder.ts`)

### 2a. Track the winning event's `ts` for each manual signal

- In the **`system.task` loop**, alongside setting `currentTask`/`currentProject`/`deadline`, record the
  `ts` of the event that last **touched** each key: `taskEventTs`, `projectEventTs` (deadline uses its own
  value-based rule, no ts needed). The last write in seq order wins (loop already runs seq-ascending).
- In the **blocked loop**, record `blockedEventTs = e.ts` inside the existing `if (e.seq > lastBlockedSeq)`
  branch (the winning blocked event).

### 2b. Decay, after each field is fully derived but BEFORE the inference fallbacks

Let `nowMs = clock.getTime()`.

- **blocked** — after the existing `lastUnblockedSeq > lastBlockedSeq` resolution:
  `if (blocked && blockedEventTs && nowMs - Date.parse(blockedEventTs) > BLOCKED_TTL_MS) { blocked = false; blockedReason = null; }`
- **task / project** — after the `system.task` loop, **before** the Phase-15/16 `if (currentTask === null)` /
  `if (currentProject === null)` fallbacks (so decay → null → inference runs):
  `if (currentTask && taskEventTs && nowMs - Date.parse(taskEventTs) > MANUAL_TASK_TTL_MS) currentTask = null;`
  (same for `currentProject`/`projectEventTs`).
- **deadline** — after it is derived:
  `if (deadline && deadlineLongOverdue(deadline, generatedAt, DEADLINE_STALE_DAYS)) deadline = null;`
  where `deadlineLongOverdue` reuses date-only logic **local to the builder** (do NOT import from the
  Planner — state is below the planner in the layer graph). Non-date deadlines (e.g. `"tomorrow"`) return
  `false` → never decay.

---

## 3. Acceptance criteria (every one tested, with a controlled clock + explicit old `ts`)

Tests must write events with an **explicit old `ts`** (a new `writeRawEventAt` helper) and pass a controlled
`buildState(now)` clock — the existing `writeRawEvent` stamps `ts = now`, which cannot exercise decay.

1. **Fresh block stays.** `system.blocked` with `ts` 1 h before `now` → `blocked === true`.
2. **Stale block decays.** `system.blocked` with `ts` 25 h before `now`, no unblock → `blocked === false`,
   `blockedReason === null`.
3. **Stale block, then a fresh block, stays.** Old block + newer block (1 h old) → `blocked === true` (the
   winning event is fresh).
4. **Unparseable ts → keep** (defensive): a blocked event with a garbage `ts` → `blocked === true`.
5. **Stale manual task decays to branch inference.** `git.branch_switch → feat/dark-mode` + a manual
   `system.task {task:"old thing"}` 4 days old → `currentTask === "dark mode"` (branch fallback), not
   `"old thing"`.
6. **Fresh manual task stays.** manual task 1 h old → kept.
7. **Stale manual project decays to activeRepo.** repo-tagged commit (`repo:"myshi"`) + manual
   `system.task {project:"old-proj"}` 4 days old → `currentProject === "myshi"`.
8. **Long-overdue deadline retires.** `deadline:"2026-07-01"`, clock `2026-07-20` (19 days overdue) →
   `deadline === null`.
9. **Freshly-overdue deadline is kept** (Phase 32 still nags it). `deadline:"2026-07-18"`, clock
   `2026-07-20` (2 days) → `deadline === "2026-07-18"`.
10. **Non-date deadline never decays.** `deadline:"tomorrow"`, any clock → kept.
11. **All existing builder tests stay green** (their event `ts` is `now` and their clocks are in the past →
    negative age → no decay; the one overdue-deadline fixture is only 2 days over < 7).

**Sabotage check (run it):** delete the blocked-decay line → criterion 2 goes red; delete the task-decay
line → criterion 5 goes red; delete the deadline-decay line → criterion 8 goes red. Restore.
