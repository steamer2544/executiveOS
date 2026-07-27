# Phase 42 — Nudge quality + a readable answer signal

> **Status:** scope (contract for the implementer).
> **Driven by measurement, not a roadmap item.** Everything below comes from reading the real
> `.executive/nudges.jsonl` (18 records: 5 `sent`, 5 `answered`, 8 `suppressed`) produced by three
> days of live Phase 36 running.

---

## 1. Why (the evidence)

Two defects, both visible in the real log.

### Defect A — the nudge sentence is built from an INTERNAL LABEL

`src/report/digest.ts:137` builds every plan needs-you item as:

```ts
summary: "Planner needs your call: " + a.kind,   // a.kind = "long_session" | "grinding_on_file" | ...
detail:  a.reason ?? undefined,                   // ← the actually-human sentence
```

`PlannerAction.reason` is documented in `src/planner/types.ts:22` as *"human-readable, references the
State field that fired it"* — it is the good content. But `src/proactive/compose.ts` `buildPrompt()`
sends the **summary** as `งานที่ต้องตัดสินใจ:` (the thing to decide) and demotes `detail` to
`รายละเอียด:` (a footnote). **The substance and the label are inverted.**

Measured consequences in the real log:

| # | Composed by | Text | Verdict |
|---|---|---|---|
| 1 | llm | "คุณต้อง**โทรหา** Planner สำหรับ long_session …" | ❌ tells the owner to *phone* a code module |
| 8 | llm | "…Planner ต้องการการตัดสินใจของคุณครับ" | ⚠️ leaks "Planner", but coherent |
| 10 | llm | "ผมเห็นว่า Planner ต้องการการ**ติดต่อกลับ**จากคุณ…" | ❌ "contact it back" — same mistranslation |
| 15 | llm | "ไฟล์ `agent\tools.ts` ถูกบันทึกซ้ำ 18 ครั้งใน 30 นาที …" | ✅ **the one good nudge — it used `detail` and ignored `summary`** |
| 3 | fallback | "Planner needs your call: grinding_on_file — state\builder.ts saved 17 times in 30 min …" | ❌ raw rule name shipped to the owner |

So: **2 of 4 LLM nudges are semantically broken**, the fallback leaks the raw `ActionKind`, and the
single good one is the one that ignored the label. "needs your call" is an English idiom the model
mistranslates as a telephone call; `long_session` / `grinding_on_file` are internal identifiers the
owner should never see.

### Defect B — `answered` is too blunt to interpret

`HANDOFF.md` says the whole point of `nudges.jsonl` is the **sent-vs-answered ratio**, and that it
gates the deferred `agent.proactive.trigger: "rules+llm"` dial. As built, that ratio cannot be read:

- `markNudgeAnswered()` (`src/proactive/proactive.ts:155`) is called on **any** owner message
  (`src/index.ts:191`, `src/ui/server.ts:361`) and closes the most recent open nudge **regardless of
  how old it is**.
- Real latencies: **51 s, 2.4 min, 8 min, 43 min, 1 h 55 min**. The last two are almost certainly the
  owner happening to chat later about something else — but they are recorded identically to the 51-second
  reply.
- The record is `{event:"answered", id, ts}` — no latency — so reading the log means hand-joining
  lines by `id` to learn anything.

The headline number is currently **5/5 = 100% answered**, which is not a real measurement.

---

## 2. Goal

1. A nudge sentence never contains an internal identifier, and is written from the human reason.
2. `nudges.jsonl` can be read at a glance to answer *"did the owner reply while the nudge was live?"*

Deterministic where possible; no new LLM call, no new nudge source, no new config block.

---

## 3. Job 1 — the internal label must never be the task

**File:** `src/proactive/compose.ts` only.

### 3.1 New exported pure function

```ts
/**
 * The human-meaningful subject of a nudge.
 *
 * `summary` is an INTERNAL dedup key (e.g. "Planner needs your call: long_session") — it keys
 * suppression and notification dedup, so it must stay stable and must never be shown to the owner.
 * `detail` is the human sentence (PlannerAction.reason). Prefer it.
 */
export function nudgeSubject(nudge: Nudge): string
```

- Returns `nudge.detail` when it is a non-empty string after `trim()`.
- Otherwise returns `nudge.summary` (the non-plan sources — `autopilot` / `executor` / `worker` —
  already have a human summary and often no detail).
- Never returns an empty string when either field has content; returns `""` only when both are empty.

### 3.2 `buildPrompt(nudge)` changes

- Lead with `nudgeSubject(nudge)` as the thing to decide.
- **Do NOT send `nudge.summary` at all when a detail exists.** This is the fix — the phrase
  "needs your call" and the raw `ActionKind` must not reach the model, because it cannot be trusted
  to ignore them (measured: it echoed them 2 of 4 times).
- Add an explicit instruction line forbidding internal identifiers, e.g.
  `- ห้ามใช้ชื่อภายในระบบ ชื่อโมดูล หรือชื่อกฎ (identifier แบบ snake_case) — เขียนด้วยภาษาคนธรรมดา`
  **The instruction line must NOT name the forbidden identifiers as examples.** Spelling them out
  would put those exact strings back into the prompt — which is the bug — and would contradict
  acceptance criterion 4. Describe the *category*, never an instance.
- Keep every existing instruction (Thai, 1–2 sentences, address the owner as "คุณ" / self as "ผม",
  end in a one-line-answerable question, no greetings, invent nothing, keep it short).

### 3.3 `deterministicFallback(nudge)` changes

- Return `nudgeSubject(nudge)` — i.e. the detail when present, else the summary.
- It must **no longer** concatenate `summary + " — " + detail` (that is what shipped
  `"Planner needs your call: grinding_on_file — state\builder.ts saved 17 times…"`).
- Still never throws; still returns a non-empty string whenever the nudge has any text.

### 3.4 Unchanged

`composeNudge`'s signature, its `try/catch`, the `{ text, composedBy }` result shape, the
`backendFactory` injection seam, and the "empty LLM text → fallback" rule are all unchanged.

---

## 4. Job 2 — make the answer signal readable

**Files:** `src/proactive/types.ts`, `src/proactive/proactive.ts`.

### 4.1 Record shape

In `src/proactive/types.ts`, `NudgeRecord` gains a latency on `answered` and a new closing variant:

```ts
export type NudgeRecord =
  | { event: "sent"; id: string; ts: string; key: string; source: string; summary: string; text: string; composedBy: "llm" | "fallback" }
  | { event: "answered"; id: string; ts: string; latencyMs: number }
  | { event: "expired";  id: string; ts: string; ageMs: number }
  | { event: "suppressed"; ts: string; key: string; reason: string };
```

**Backward compatibility is required and must be tested:** the 5 `answered` records already on disk
have **no `latencyMs`**. Nothing may crash, skip, or rewrite them. Do **not** migrate or backfill the
existing log.

### 4.2 The answer window

In `src/proactive/proactive.ts`, export:

```ts
/**
 * A reply only counts as answering a nudge if it arrives within this window.
 *
 * Measured from the real log: observed latencies were 51 s, 2.4 min, 8 min, 43 min and 1 h 55 min —
 * the last two are the owner happening to chat later, not a reply. 30 min also equals the default
 * `minGapMs`, so at most one nudge is ever live inside one window.
 *
 * A constant, not config — consistent with Phase 39's BLOCKED_TTL_MS / MANUAL_TASK_TTL_MS.
 */
export const ANSWER_WINDOW_MS = 30 * 60 * 1000;
```

### 4.3 `markNudgeAnswered(now?: Date)`

Signature gains an optional injected `now` (default `new Date()`) so it is testable without mocking
time — the same discipline `rules.ts` already follows.

Behaviour:

1. Find the open nudge via `openNudgeId` (unchanged logic, see 4.4). No open nudge → **no-op**.
2. Find that nudge's `sent` record and parse its `ts`.
3. `elapsed = now - sentTs`.
   - `elapsed <= ANSWER_WINDOW_MS` → append `{ event: "answered", id, ts, latencyMs: elapsed }`.
   - otherwise → append `{ event: "expired", id, ts, ageMs: elapsed }`.
4. Either way the nudge is **closed** (see 4.4) — exactly one record is appended, never two.
5. An unparseable or missing `sent` ts → treat as **answered with `latencyMs: 0`** rather than
   throwing or losing the record. (Uncertain → keep the weaker claim, same rule as Phase 39's decay.)
6. Still **never throws**.

`elapsed` must be clamped to `>= 0` (a clock skew must not write a negative latency).

### 4.4 `openNudgeId` must treat `expired` as closing

`openNudgeId(history)` currently builds its closed-set from `answered` ids only. It must now treat
**both `answered` and `expired`** as closing a nudge.

This is load-bearing: without it an expired nudge stays open forever, and the *next* message — however
much later — would expire it again, appending a duplicate record every single time the owner speaks.
**This needs its own test.**

### 4.5 Unchanged

`runProactiveTick`, `decideNudge`, `sentToday` (filters `event === "sent"`, so the new variant is
inert), the suppression logging, `NON_LOGGED_REASONS`, and both call sites in `src/index.ts` /
`src/ui/server.ts` (they call `markNudgeAnswered()` with no argument — the new parameter is optional).

---

## 5. What is NOT in scope

- **Do NOT change the `summary` strings in `src/report/digest.ts`.** They look like the obvious place
  to fix Defect A, but `summary` is the dedup key (`key = source + "|" + summary` in
  `proactive.ts:58`, plus `needsYouSignature` and `notify.ts`). Changing it invalidates every key
  already written to `nudges.jsonl` and `notifications.jsonl`, so 24 h repeat-suppression would see
  every item as new and fire a one-time nudge burst. The bug is in the presentation layer; fix it there.
- **Do NOT add `agent.proactive.trigger: "rules+llm"`** or any second nudge source. It is deliberately
  deferred until this baseline is readable — that is the entire point of this phase.
- **Do NOT change** `rules.ts` (decision order, quiet hours, min gap, daily budget, repeat suppression).
- **Do NOT touch** `src/channel/*`, `src/agent/*`, the digest sections, the dashboard, or the CLI.
- **No new config block, no new CLI command, no new event source.**
- **Do NOT rewrite, migrate, backfill, or compact the existing `nudges.jsonl`.**
- No changes to `README.md` / `CLAUDE.md` / `HANDOFF.md` / `GOTCHA.md` (the architect writes those).

---

## 6. Acceptance criteria

Each must be a real, runnable test. Add them to `src/proactive/proactive.test.ts` (Job 2) and
`src/proactive/compose.test.ts` (Job 1 — create it if absent).

**Job 1 — compose**

1. `nudgeSubject` returns `detail` when detail is a non-empty string.
2. `nudgeSubject` returns `summary` when `detail` is `undefined`, `""`, or whitespace-only.
3. `nudgeSubject` returns `""` when both are empty.
4. The prompt built for a plan nudge (`summary: "Planner needs your call: long_session"`,
   `detail: "90 minutes with no break — worth a short pause"`) **contains the detail** and **does not
   contain** the substrings `"long_session"`, `"needs your call"`, or `"Planner"`.
5. The prompt for a nudge with **no** detail (`summary: "Autopilot stopped and needs you"`) still
   contains that summary (nothing is lost for the non-plan sources).
6. `deterministicFallback` output for the plan nudge in (4) equals the detail exactly — it does not
   contain `"long_session"` or `"needs your call"`.
7. `composeNudge` with a backend that throws still returns `{ composedBy: "fallback" }` and the
   fallback text from (6) — the existing contract is intact.
8. `composeNudge` with a backend returning empty text falls back the same way.

**Job 2 — answer signal**

9. A nudge sent 5 minutes ago → `markNudgeAnswered(now)` appends exactly one record,
   `{ event: "answered", latencyMs: 300000 }`, with the right `id`.
10. A nudge sent 2 hours ago → appends exactly one `{ event: "expired", ageMs: 7200000 }` record,
    and **no** `answered` record.
11. **Boundary:** exactly `ANSWER_WINDOW_MS` old → `answered` (inclusive, per 4.3).
    One millisecond past it → `expired`.
12. After a nudge is `expired`, a second `markNudgeAnswered()` call appends **nothing**
    (`openNudgeId` treats `expired` as closed — criterion 4.4).
13. No open nudge (empty log, or every sent nudge already closed) → appends nothing, does not throw.
14. A log containing a legacy `{ event: "answered", id, ts }` record **with no `latencyMs`** is read
    without throwing, and that nudge is still correctly treated as closed.
15. A `sent` record with an unparseable `ts` → `answered` with `latencyMs: 0` (never throws, never
    writes a negative or `NaN` latency).
16. `sentToday` still counts only `sent` records when the history also contains `expired` records.

**Whole suite**

17. `bun test` — all previously passing tests still pass, plus the new ones.
18. `bun run typecheck` — clean.

---

## 7. Sabotage check (required — run it, do not assume)

The point of this step is that it is the one claim that cannot be verified by reading the diff.
Break the code, run the suite, confirm the expected tests go **red**, then restore.

| # | Sabotage | Must fail |
|---|---|---|
| 1 | Make `buildPrompt` send `nudge.summary` as the task again | criterion 4 |
| 2 | Make `deterministicFallback` return `summary + " — " + detail` again | criterion 6 |
| 3 | Remove the window check — always write `answered` | criteria 10, 11 |
| 4 | Revert `openNudgeId` to closing on `answered` only | criterion 12 |

Report which test names failed for each. If a sabotage leaves the suite **green**, the test is
vacuous — fix the test, not the report.

---

## 8. Files

**Edit:** `src/proactive/compose.ts`, `src/proactive/proactive.ts`, `src/proactive/types.ts`,
`src/proactive/proactive.test.ts`
**Create:** `src/proactive/compose.test.ts` (if it does not already exist)

Nothing else.
