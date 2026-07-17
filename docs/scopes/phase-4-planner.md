# Scope — Phase 4: Planner (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context beyond Phases 1–3. Read
> `docs/scopes/phase-1-runtime.md`, `docs/scopes/phase-2-eventbus-watchers.md`,
> `docs/scopes/phase-3-state-builder.md`, and `CLAUDE.md` first — this builds directly on the Phase 3
> `State`/`Context` (`src/state/`) and the `watch` daemon.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **Primary OS: Windows 11 (Bun on
> Windows) — everything must work there.**

---

## 0. What this phase is (and is NOT)

Phase 3 gives us a compact **`State`** ("what is true right now"). Phase 4 adds the **Planner**: a
**100% rule-based** engine that reads that `State` and answers one question —

> **"What is the highest-value action right now?"**

It emits a **`Plan`** (a ranked list of *proposed* actions, each with a reason, priority, confidence,
and an `act`/`ask` disposition) and writes it to **`.executiveOS/plan.json`**.

**Critical boundaries:**

- **The Planner is a Rule engine, NOT an LLM.** No Claude/Qwen call, no prompt, no reasoning model.
  It is deterministic `if/else` over `State`. (The vision doc: *"Planner ไม่ใช่ LLM, Planner เป็น Rule …
  LLM มาใช้ตอนคิด ไม่ใช่ตอนเลือกว่าจะคิดอะไร."* The LLM Worker is **Phase 5** — not here.)
- **The Planner DECIDES, it does NOT EXECUTE.** It never runs git, never runs tests, never commits,
  never edits files. It only *proposes* actions into `plan.json`. Carrying them out is Phase 5.
- **The Planner reads `State`/`Context` ONLY — never the raw event logs.** This is the architectural
  contract from the vision doc: *"new event sources … can be plugged in without modifying the
  planner."* Because it consumes the Phase 3 abstraction, adding a watcher later never touches Phase 4.

**In scope:**
1. `src/planner/types.ts` — `ActionKind`, `Disposition`, `ProposedAction`, `Plan` + constants.
2. `src/planner/rules.ts` — the ordered rule set (pure `(state) => ProposedAction | null` functions).
3. `src/planner/planner.ts` — `plan(state, context?)` (pure) + `writePlan(...)` (atomic persist to
   `.executiveOS/plan.json`) + the exported `applyGuardrail(...)` helper.
4. A one-shot **`plan`** CLI command.
5. Plan rebuild wired into the existing **`watch`** daemon — recomputed right after each state rebuild
   (startup + interval), so `plan.json` always tracks `state.json`.
6. `statePath()`-style `planPath()` helper in `src/paths.ts`.
7. Tests.

**NOT in scope (do not build — later phases):**
- ❌ Any LLM / Claude / Qwen / MCP call (Phase 5 Worker).
- ❌ **Executing** any action — no running git/tests, no commits, no file edits, no shell-outs. Phase 4
  writes `plan.json` and stops.
- ❌ New watchers / event sources (terminal/github/calendar/discord/browser). Phase 4 consumes `State`.
- ❌ A Scheduler module or timed re-review cadences (e.g. "review every 15 min"). One plan per state
  rebuild — the planner is a **pure, stateless, one-shot** function. No cron, no its own interval.
- ❌ SQLite / Drizzle — **still JSONL** (and the planner doesn't even read the logs).
- ❌ No web server, no HTTP, no Elysia, no VSCode extension.
- ❌ Do NOT create `.executiveOS/claude.md` / `rules.md` / `planner.md`. Those are **product** config
  artifacts for Phase 5. **Phase 4's rules live in CODE (`src/planner/rules.ts`), not in a `.md` file.**
- ❌ No new `config.json` block. The plan piggybacks on the existing `state.intervalMs` cadence — do
  NOT add a `planner` config key.

If tempted to add any ❌ item: **STOP.**

---

## 1. Input the Planner reads

`plan(state, context?)` takes the **Phase 3 `State`** (required) and optionally the `Context` (for
provenance / summary only). It reads **nothing else** — no `read()`, no `tail()`, no event-log files,
no `now` clock beyond `generatedAt` passed in. Same `State` in → same `Plan` out (deterministic).

Relevant `State` fields (see `src/state/types.ts`) and what they trigger:

| State signal | Meaning | Feeds rule |
|---|---|---|
| `tests === "failing"` | test suite is red | R1 `fix_tests` |
| `blocked === true` (+ `blockedReason`) | work is stuck on something | R2 `resolve_block` |
| `deadline !== null` | a due date is set | R3 `review_deadline` |
| `activity.active === false` **and** `currentTask !== null` | idle mid-task | R4 `resume_task` |
| none of the above | nothing needs doing | (no action) |

---

## 2. Types (`src/planner/types.ts`)

```ts
/** The finite, stable set of actions the rule engine can propose in Phase 4. */
export type ActionKind =
  | "fix_tests"        // tests are failing → fix them
  | "resolve_block"    // work is blocked → surface / resolve the blocker
  | "review_deadline"  // a deadline exists → review progress against it
  | "resume_task";     // idle mid-task → nudge back to the current task

/** Whether the Planner considers this safe to do autonomously, or must ask first. */
export type Disposition = "act" | "ask";

export interface ProposedAction {
  kind: ActionKind;
  reason: string;         // human-readable, references the State field that fired it
  priority: number;       // higher = more urgent (see §3 for the fixed scale)
  confidence: number;     // 0..1 — how sure the rule is this is the right call
  forbidden: boolean;     // true if it touches a guardrail category (§5) → always "ask"
  disposition: Disposition; // "act" iff (!forbidden && confidence > CONFIDENCE_THRESHOLD)
}

export interface Plan {
  generatedAt: string;    // ISO, when this plan was built (from State.generatedAt)
  basedOnState: {         // provenance link back to the snapshot this was derived from
    generatedAt: string;
    eventCount: number;
  };
  topAction: ProposedAction | null;  // highest-priority action, or null if none fired
  actions: ProposedAction[];         // ALL fired actions, sorted priority DESC (then rule order)
  summary: string;                   // one-line human-readable rollup (see §4)
}

/** Guardrail: only propose autonomous action when strictly above 95% confidence. */
export const CONFIDENCE_THRESHOLD = 0.95;
```

- `topAction` is `actions[0]` after sorting, or `null` when `actions` is empty.
- Keep `ActionKind` closed (a union). Do NOT invent extra kinds beyond the four above.

---

## 3. The rule set (`src/planner/rules.ts`)

Implement the rules as an **ordered array of pure functions**, each `(s: State) => ProposedAction | null`
(return `null` when the rule doesn't fire). This is the whole point of a rule engine: adding/removing a
rule = editing this one array, and every decision is inspectable.

Use these **fixed** priorities / confidences (so tests are exact):

| # | Fires when | `kind` | `priority` | `confidence` | `forbidden` | Resulting disposition |
|---|---|---|---|---|---|---|
| R1 | `s.tests === "failing"` | `fix_tests` | `100` | `0.97` | `false` | **`act`** (0.97 > 0.95) |
| R2 | `s.blocked === true` | `resolve_block` | `90` | `0.60` | `false` | `ask` |
| R3 | `s.deadline !== null` | `review_deadline` | `70` | `0.80` | `false` | `ask` |
| R4 | `s.activity.active === false && s.currentTask !== null` | `resume_task` | `40` | `0.50` | `false` | `ask` |

- `reason` strings must reference the trigger, e.g. R1 → `"tests are failing — fix them before moving on"`,
  R2 → `"blocked: " + (s.blockedReason ?? "unknown reason")`, R3 → `"deadline set (" + s.deadline + ") — review progress"`,
  R4 → `"idle mid-task (" + s.currentTask + ") — resume"`. Exact wording is up to you but must be a pure
  function of `State`.
- Export the ordered list, e.g. `export const RULES: Array<(s: State) => ProposedAction | null> = [...]`.
- Each rule sets `forbidden` and computes `disposition` via `applyGuardrail` (§5) — OR returns the raw
  action and lets `plan()` run every action through `applyGuardrail`. **Pick the second: rules return
  actions with `forbidden` set but `disposition` filled by the central guardrail pass in `plan()`.**
  (One place decides `act` vs `ask` → the guardrail can never be bypassed by a rule.)

> All four Phase-4 kinds are dev-workflow actions, so `forbidden` is `false` for every rule here. The
> `forbidden` field + guardrail machinery still exist and are exercised by tests (§9) so that when later
> phases add higher-stakes actions the safety rail is already structural, not bolted on.

---

## 4. `plan()` and `writePlan()` (`src/planner/planner.ts`)

```ts
export function plan(state: State, context?: Context): Plan;
export function writePlan(p: Plan): void;
```

`plan(state, context?)`:
1. Run every rule in `RULES` against `state`; collect the non-null `ProposedAction`s.
2. Run **each** collected action through `applyGuardrail` (§5) to set its `disposition`.
3. **Sort** the actions by `priority` DESC; ties keep original rule order (stable sort).
4. `topAction` = `actions[0] ?? null`.
5. `basedOnState` = `{ generatedAt: state.generatedAt, eventCount: state.eventCount }`.
6. `generatedAt` = `state.generatedAt` (the plan is *of* that snapshot — do NOT call `new Date()` here;
   stay pure).
7. `summary` = one line, e.g.
   `Top: <kind> (<disposition>, p<priority>) — <reason>` , or `No action needed.` when `topAction` is
   null. Pure function of the `Plan`.

`writePlan(p)`:
- Writes `.executiveOS/plan.json`, pretty-printed (`JSON.stringify(p, null, 2) + "\n"`), **atomically**
  (temp file in the same dir + `renameSync` — identical technique to `writeState` in
  `src/state/builder.ts`). Ensure `.executiveOS/` exists first (mirror `writeState`).

> Path: add `planPath()` to `src/paths.ts` = `execRoot() + "/plan.json"`, following the existing
> forward-slash style and sitting next to `statePath()` / `contextPath()`.

---

## 5. Guardrail (`applyGuardrail`) — the safety rail

```ts
export function applyGuardrail(action: ProposedAction): ProposedAction;
```

A **pure** function that returns a copy of `action` with `disposition` set by the single rule:

```
disposition = (!action.forbidden && action.confidence > CONFIDENCE_THRESHOLD) ? "act" : "ask";
```

- This is the ONLY place `disposition` is decided. Rules must not set `disposition` themselves.
- `forbidden === true` → **always** `"ask"`, regardless of confidence (a forbidden category can never be
  auto-acted). This encodes the standing guardrail: the system must never autonomously decide
  **relationships, morality, large spending, or life-goal changes** — any future action touching those
  sets `forbidden = true`.
- Confidence at or below the threshold → `"ask"` (mirrors *"Confidence > 95% → act; otherwise ask"*).

Every proposed action is inspectable (JSON with `reason`, `confidence`, `disposition`) and reversible
(a plan is just a file; nothing is executed). Keep it that way.

---

## 6. CLI: `plan` (`src/index.ts`)

Add one command:

| Command | Behavior |
|---|---|
| `plan` | `bootstrap()` → `buildState()` → `plan(state, context)` → `writePlan(...)`. Print a concise line to stdout: the resolved `plan.json` path and the `Plan.summary`. Exit 0. On error, stderr + exit 1. |

- Existing `init` / `emit` / `tail` / `build-state` / `watch` / `--help` stay; update `--help` to
  include `plan`.
- `build-state` and `plan` are separate one-shot commands; `plan` internally builds a fresh state first
  (so it works standalone without the user having run `build-state`).

---

## 7. Wire the plan rebuild into the `watch` daemon (`src/index.ts`)

In the `watch` command, wherever the state is (re)built — **both** the startup rebuild and the
`setInterval` rebuild — compute and write the plan immediately after `writeState(...)`:

```
const built = buildState();
writeState(built);
const p = plan(built.state, built.context);
writePlan(p);
```

- Wrap in the existing try/catch — a plan failure logs to stderr and must **NEVER** crash the daemon.
- **Do NOT add a second `setInterval`** for the planner. The plan follows the state cadence (one plan per
  state rebuild). No new timer means nothing new to `clearInterval` on SIGINT.
- Optionally print the plan summary on the startup rebuild line (keep output lightweight).

---

## 8. Housekeeping

- `.gitignore`: **no change needed.** The whole `.executiveOS/` tree is already ignored (Phase 3.5
  rename commit), so `plan.json` is covered automatically. Do **not** re-add per-file ignores.
- `bootstrap()` does **not** need to pre-create `plan.json` (produced by `plan`/`watch`). Do not change
  bootstrap.
- Do not modify `src/state/`, `src/config.ts`, `src/bootstrap.ts`, or the watchers for this phase
  (beyond the daemon wiring in `index.ts`).

---

## 9. Tests (`bun test`) — required, in `src/planner/planner.test.ts`

Construct `State` objects directly (a small `makeState(overrides)` helper is fine) — you do **not** need
`EXECUTIVE_HOME`/events for the pure tests, but the `writePlan` round-trip test should use a temp
`EXECUTIVE_HOME` like Phases 1–3. Cover:

1. **empty / clean state**: `tests:"unknown"`, `blocked:false`, `deadline:null`, `activity.active:true`
   → `actions` is `[]`, `topAction` is `null`, `summary` is the "no action" line.
2. **failing tests → act**: `tests:"failing"` → an action `{kind:"fix_tests", priority:100,
   confidence:0.97, disposition:"act"}` and it is `topAction`.
3. **blocked → ask**: `blocked:true, blockedReason:"waiting review"` → `resolve_block`,
   `disposition:"ask"`, `reason` includes the blocker.
4. **deadline → ask**: `deadline:"tomorrow"` → `review_deadline`, `disposition:"ask"`.
5. **idle mid-task → ask; active mid-task → no resume**: `activity.active:false, currentTask:"T"` fires
   `resume_task`; the same with `activity.active:true` does NOT fire it.
6. **priority ordering**: a state with failing tests **and** blocked **and** a deadline → `actions`
   sorted `[fix_tests(100), resolve_block(90), review_deadline(70)]` and `topAction.kind === "fix_tests"`.
7. **guardrail is central & unbypassable**:
   - `applyGuardrail({...,forbidden:false,confidence:0.99})` → `disposition:"act"`.
   - `applyGuardrail({...,forbidden:false,confidence:0.95})` → `disposition:"ask"` (boundary: not `> 0.95`).
   - `applyGuardrail({...,forbidden:true,confidence:0.99})` → `disposition:"ask"` (forbidden wins).
8. **determinism**: `plan(sameState)` twice → deep-equal plans (no `Date.now()`, no randomness).
9. **`plan` reads only State**: assert `src/planner/rules.ts` and `planner.ts` do not import the event
   store / `read` / `tail` (grep-level check is acceptable in the review, but include an architectural
   comment). At minimum: `plan()` must produce a correct `Plan` from a hand-built `State` with **no**
   `.executiveOS/` on disk.
10. **writePlan round-trip**: `writePlan(plan(state))` creates valid JSON at `planPath()`; re-read +
    `JSON.parse` succeeds; `basedOnState` matches the source state; `actions` is an array.

---

## 10. Acceptance criteria (Claude will verify ALL by running them)

- [ ] `bun run typecheck` passes (strict), zero errors.
- [ ] `bun test` passes — all §9 tests green **and** the existing Phase 1/2/3 suites still pass.
- [ ] Live CLI: in a temp `EXECUTIVE_HOME`, `init`, then `emit` events that produce a failing-tests +
      deadline state (`system.test_result{status:"failing"}`, `system.task{deadline:"tomorrow"}`), then
      `plan` → `plan.json` exists, is valid JSON, `topAction.kind === "fix_tests"`,
      `topAction.disposition === "act"`, and `review_deadline` appears as `ask` (Claude asserts exact
      values).
- [ ] Live CLI: a clean state (no failing tests / block / deadline, active) → `plan` prints the
      "No action needed" summary and `plan.json.topAction` is `null`.
- [ ] `executive watch` writes `plan.json` at startup and refreshes it on the state interval alongside
      `state.json` (Claude drives live with a short `state.intervalMs`; a real change that flips state is
      reflected in a rebuilt `plan.json`). Ctrl-C still exits without hanging (no new timer added).
- [ ] `plan.json` is gitignored (whole `.executiveOS/` tree — verify with `git check-ignore`).
- [ ] No out-of-scope features: **no LLM/Claude call, no execution of any action** (no git/test/commit
      shell-outs), no new watchers, no SQLite, no server, no new config block, no `.executiveOS/*.md`
      artifacts, no extra scheduler/interval.

---

## 11. Deliverable

A commit adding `src/planner/types.ts`, `src/planner/rules.ts`, `src/planner/planner.ts`,
`src/planner/planner.test.ts`, the `paths.ts` (`planPath`) and `index.ts` (`plan` command + daemon
wiring) changes. No `.gitignore` / `config.ts` / `bootstrap.ts` changes. Leave this doc in place. Do NOT
commit `.executiveOS/` runtime data (including `plan.json`). Hand back for review — Claude runs every
item in §10, including a live `plan` (failing-tests state → `fix_tests`/`act`) and a live `watch`
plan-refresh.
