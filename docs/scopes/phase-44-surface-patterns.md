# Phase 44 — Show the owner the numbers the system reasons over

> **Read this spec only.** Do NOT read `CLAUDE.md`, `HANDOFF.md` or `GOTCHA.md` — everything you need
> is here. Work file by file; `grep` rather than reading whole files.
>
> **NEVER print full test output** — always `bun test 2>&1 | tail -20`. The suite prints 880+ `(pass)`
> lines and a few full runs will exhaust your context before you finish.
>
> Repo root: `C:\Users\yiw20\Programming\myshi\executive`. Runtime: **Bun + TypeScript (strict)**.
> `bun run typecheck` must stay green. Keep the final report under 20 lines.

---

## 1. Why

`src/state/patterns.ts` computes five behavioural metrics into `State.patterns`:

| field | meaning |
|-------|---------|
| `msSinceLastCommit` | ms since the newest `git.commit`, or `null` if there has never been one |
| `editsSinceLastCommit` | `editor.save` events newer than the newest commit |
| `sameFileSaves30m` | saves of the current file in the last 30 minutes |
| `sessionMs` | length of the current continuous activity run (`null` when unknown) |
| `repoSwitches1h` | distinct repo changes in the last hour (observability only — no rule uses it) |

The **Planner** fires rules off them (`checkpoint_work`, `grinding_on_file`, `long_session`) and the
**Advisor** must cite them as evidence in every proposal. So the owner regularly reads a recommendation
like *"113 edits over 11.5h with no commit"* — and has **no way to see the underlying numbers** without
opening `.executive/state.json` by hand.

This phase surfaces them. It is **pure presentation**: read-only, deterministic, **no LLM**, no new
computation. Every value already exists.

---

## 2. Goal

A **"Working pattern"** line in the rendered digest and a matching row in the dashboard's **Now** card,
showing the five numbers in **human units**.

**Units are the point of this phase, not a detail.** Raw milliseconds have already caused a real,
repeated failure elsewhere in this codebase (a model read `sessionMs: 2173707` as "~36 hours"; it is 36
*minutes*). Never render a raw ms number to a human either.

---

## 3. Job 1 — a pure formatter

New exported function in **`src/report/digest.ts`**, next to the other helpers at the bottom:

```ts
/**
 * One human-readable line describing the current working pattern, or null when
 * there is nothing worth saying.
 */
export function formatPatterns(p: Patterns | null | undefined): string | null;
```

### 3.1 Rules

1. `null` / `undefined` input → return `null`.
2. Build **only the parts that carry information**, joined with `" · "`:
   - `sessionMs` → `"session 1h 25m"` (omit when `null`)
   - `msSinceLastCommit` → `"last commit 3h 10m ago"` (omit when `null` — never invent "never")
   - `editsSinceLastCommit` → `"12 edit(s) since"` (omit when `0`)
   - `sameFileSaves30m` → `"9 save(s) of the current file in 30m"` (omit when `0`)
   - `repoSwitches1h` → `"2 repo switch(es) in 1h"` (omit when `0`)
3. If **no** part survives, return `null` — a fresh install must not render an empty bullet.
4. Duration formatting: `< 1 min` → `"under a minute"`; `< 1 h` → `"25m"`; otherwise `"3h 10m"`, and
   drop a zero minutes component (`"3h"`, not `"3h 0m"`). Round down; never show decimals or ms.
5. **Pure.** No `Date.now()`, no I/O — the values are already relative to the state's own clock.

Add a small `formatDuration(ms: number): string` helper if it keeps this readable; it may stay
non-exported.

---

## 4. Job 2 — render it

### 4.1 `Digest` type — `src/report/types.ts`

Add to the `now` block:

```ts
/** Human-readable working-pattern line, or null when there is nothing to say. */
workingPattern: string | null;
```

### 4.2 `buildDigest` — `src/report/digest.ts`

Set `workingPattern: formatPatterns(rawState?.patterns)` when building `now`. `rawState` is already
read defensively there — a missing/malformed `state.json` must still produce a valid digest with
`workingPattern: null`. Do **not** add a second read of `state.json`.

### 4.3 `renderDigest` — `src/report/digest.ts`

In the `## Now` section (around line 267, after the `**Idle:**` line), add:

```
- **Working pattern:** session 1h 25m · 12 edit(s) since · last commit 3h 10m ago
```

**Only when `workingPattern` is non-null.** Do not print a `—` placeholder row: this line is
supplementary, and an empty one on a fresh install is noise.

### 4.4 Dashboard — `src/ui/page.ts`

The **Now** card is built from a `rows([...])` array around line 338. Add a `["Working pattern", …]`
row **after `Idle`**, rendered only when `n.workingPattern` is truthy.

> ⚠️ **`src/ui/page.ts` is ONE BIG TEMPLATE LITERAL.** A backslash inside it is consumed when the
> string is emitted, so a regex written there silently breaks the whole inline script at runtime while
> `bun test` stays green. **Do not write any regex or backslash escape in this file.** Everything this
> phase needs is plain string concatenation. Escape user-visible values with the existing `esc()`
> helper, exactly like the neighbouring rows.

`/api/state` already returns the whole digest, so **no server change is needed** — confirm this by
reading `src/ui/server.ts` rather than assuming, and say so in your report.

---

## 5. What is NOT in scope

- **No change to `src/state/patterns.ts`**, to what is computed, or to any threshold.
- **No change to the Planner or the Advisor.** They already read `patterns` from `State`; they must not
  read `workingPattern`.
- **No new event, no new config key, no new CLI command, no LLM call.**
- **No sparkline, chart, history or trend.** One line of text.
- **Do not touch the "Needs you", "Recommended action" or "Suggestions" sections.**
- **Do not reorder the dashboard cards.** A separate review is looking at that; a reordering here would
  collide with it.

---

## 6. Acceptance criteria

Add tests to **`src/report/digest.test.ts`** (it already has fixtures and a temp-home helper — reuse
them; `emptyPatterns()` from `src/state/patterns.js` is already imported there).

> **Every test that touches the runtime dir MUST set `process.env.EXECUTIVE_HOME`** to a temp dir and
> clear it afterwards — follow the existing pattern in that file. `execRoot()` throws under
> `NODE_ENV=test` when it is unset.

1. `formatPatterns(null)` → `null`.
2. `formatPatterns(emptyPatterns())` → `null` (all zeros/nulls ⇒ nothing to say).
3. `sessionMs: 5_100_000` (85 min) → the line contains `"session 1h 25m"`.
4. `sessionMs: 30_000` → contains `"under a minute"`, and contains **no** digit-`m`/`h` duration.
5. `msSinceLastCommit: 11_400_000` (3h10m) → contains `"3h 10m"`; a value of exactly 3 h renders
   `"3h"`, **not** `"3h 0m"`.
6. `editsSinceLastCommit: 0` → the string contains no `"edit"`; `: 12` → it does.
7. A populated `Patterns` → parts are joined with `" · "` and the output contains **no raw ms value**
   (assert the digit string of the input ms does not appear).
8. `buildDigest()` with a state file whose `patterns` are populated → `digest.now.workingPattern` is
   that same string.
9. `buildDigest()` with **no** `state.json` → does not throw, `now.workingPattern` is `null`.
10. `buildDigest()` with a `state.json` that has **no `patterns` key** (an older file) → does not throw,
    `workingPattern` is `null`.
11. `renderDigest` on a digest with `workingPattern` set → the markdown contains
    `"- **Working pattern:**"` inside the `## Now` section.
12. `renderDigest` on a digest with `workingPattern: null` → the markdown contains **no**
    `"Working pattern"` at all.
13. `renderPage()` (from `src/ui/page.ts`) still contains exactly one `<script>` block and that block
    parses: `new Function(scriptSource)` must not throw. *(This is the guard for the template-literal
    hazard in §4.4 — it fails loudly if a backslash was introduced.)*

Every existing test must keep passing. Adding a required field to `Digest["now"]` will break fixtures
that build that object literally — fix those fixtures by adding `workingPattern: null`, and do not
weaken any existing assertion.

---

## 7. Sabotage check (required — run it, do not assume)

Break the code, run `bun test 2>&1 | tail -20`, confirm the named criterion goes **red**, then restore.
Report the result for each row.

| # | Sabotage | Must fail |
|---|----------|-----------|
| 1 | `formatPatterns` returns `""` instead of `null` when nothing applies | 2, 12 |
| 2 | Render `sessionMs` as raw milliseconds | 3, 7 |
| 3 | Include zero-valued parts (`0 edit(s) since`) | 6 |
| 4 | Print the Working-pattern line unconditionally | 12 |
| 5 | Introduce a `\d` regex into `page.ts` | 13 |

---

## 8. Files

- **Edit:** `src/report/digest.ts`, `src/report/types.ts`, `src/report/digest.test.ts`, `src/ui/page.ts`
- **Do not touch anything else.** `git status` at the end must show exactly these four files (plus any
  test fixture files you had to extend with `workingPattern: null` — list them explicitly in your
  report).

---

## 9. Report

Under 20 lines: what you implemented, the criteria you ran and their result, the sabotage table with
the observed failures, whether `/api/state` needed a change (and how you verified it), and
`bun test 2>&1 | tail -3` plus `bun run typecheck` output. State plainly if any criterion is
unimplemented or failing.
