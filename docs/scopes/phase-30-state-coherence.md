# Scope — Phase 30: State coherence — prune stale `currentFile` + make the task clearable

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is here.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

ExecutiveOS derives a compact `State` from an append-only event log with one rule: **newest event wins per
field**, with **no expiry and no clearing**. Two real failure modes were seen live on the dashboard:

1. **`currentFile` sticks to a file that no longer exists.** The newest `editor.save` happened to target a
   temp/scratch file (now deleted), so the dashboard shows `editing report\.tmp-notify-test` forever.
2. **`currentTask` sticks forever.** It was set once by an old explicit `system.task` event; nothing has set
   a task since, and on the default branch (`main`) there is no branch-derived task, so a stale task from
   long ago is still shown as "current" — with **no way to clear it** (an `emit` of an empty task is
   silently ignored today).

This phase makes `State` **coherent** with reality via two small, deterministic, rule-based changes (NO LLM —
same family as the rest of the State Builder):

- **Part 1** — `currentFile` / `recentFiles` only include files that **still exist on disk**.
- **Part 2** — a task (and project) can be **cleared** by emitting an empty `system.task`, and the dashboard
  gets a **"Clear task"** button.

> A companion fix already shipped (`d3a522c`) so the FsWatcher no longer *records* temp/dotfiles going
> forward. This phase cleans up **already-recorded** stale files and adds the missing clear affordance.

### CRITICAL — hard guardrails (a violation of any is a defect)

- **Deterministic, NO LLM, NO network.** Pure derivation + a filesystem existence check. No new watcher, no
  new event source, no Planner/Worker/Executor/Synth/Autopilot/Advisor/infer changes.
- **Additive & backward-compatible.** Existing `State` fields keep their meaning. No config change. No new
  CLI command (the existing `emit` and the UI button are the only ways to clear).
- **Bias toward keeping on uncertainty (Part 1).** The existence check must be defensive: if it cannot
  determine whether a path exists (any thrown error), **keep** the file (do not drop it). Only drop a path
  when the check **positively determines** it is absent. Never throw.
- **Explicit task still wins over branch (Part 2).** Clearing means "no explicit task" → fall back to the
  Phase-15 branch-derived task (which is `null` on default branches). Do NOT delete history; clearing is
  just another `system.task` event that the builder interprets.

### Out of scope (do NOT build)

- No time-based expiry / TTL (a task can legitimately span days — do not guess staleness from age).
- No "reset the whole log" command.
- No change to how `git.branch` / `lastCommit` / `blocked` / `deadline` / `tests` / `currentWindow` are
  derived.
- No new endpoint (reuse the existing `POST /api/emit`, already whitelisted for `system.task`).

---

## 1. Part 1 — `currentFile` / `recentFiles` must exist on disk (`src/state/builder.ts`)

**Today** (`src/state/builder.ts`, ~lines 131–145): the builder walks events newest→oldest, and the newest
distinct `editor.save` `data.path` becomes `currentFile`; the next distinct ones fill `recentFiles` (cap 5).
There is no existence check, so a deleted temp file remains `currentFile`.

**Change:** when collecting `editor.save` paths, **skip any path that positively does not exist on disk.**

An `editor.save` `data.path` is the filename as seen by the FsWatcher — **relative to the watched repo
root**. Resolve it defensively against a small set of candidate roots and keep the file if it exists under
**any** of them:

- each configured repo root — `loadConfig().watch.repos[].path` (Phase 26; may be empty/absent);
- `process.cwd()` (covers the legacy single-repo case where the daemon watches the cwd);
- the path as-is (in case it is already absolute).

Suggested helper (put it near the top of `builder.ts`, keep it pure + defensive):

```ts
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** True if `p` (an editor.save path, usually repo-relative) exists under any candidate root.
 *  Defensive: any error → treat as "exists" (bias toward keeping, never throw). */
function fileStillExists(p: string, repoRoots: string[]): boolean {
  try {
    if (isAbsolute(p) && existsSync(p)) return true;
    for (const root of [...repoRoots, process.cwd()]) {
      if (existsSync(resolve(root, p))) return true;
    }
    return false;
  } catch {
    return true; // uncertain → keep
  }
}
```

- `repoRoots` = `config.watch.repos?.map(r => r.path) ?? []`. Read config via the existing `loadConfig()` the
  builder (or its caller) already has access to; if wiring config into the builder is awkward, resolving
  against `process.cwd()` + as-absolute alone is acceptable **as long as** the acceptance test in §4 passes.
  Prefer including the configured repo roots.
- Apply the check inside the existing newest→oldest `editor.save` loop: if `!fileStillExists(p, repoRoots)`,
  **skip** it (do not add to `recentFiles`, do not let it become `currentFile`). The next-newest existing
  file becomes `currentFile`. If none exist → `currentFile = null`, `recentFiles = []`.
- This must run whether or not `.executive` was polluted — a genuinely deleted source file also correctly
  drops off.

**Do NOT** add disk checks anywhere else (branch/commit/window/etc. are unaffected).

---

## 2. Part 2 — clearable task/project (`src/state/builder.ts` + `src/ui/page.ts`)

**Today** (`builder.ts`, ~lines 115–129): each `system.task` event sets `currentProject` / `currentTask` /
`deadline` **only when the field is a non-empty string** (`length > 0`). An empty string is *skipped*, so
`emit system system.task '{"task":""}'` does nothing — the old task persists. There is no clear path.

**Change:** distinguish "field absent" (leave unchanged) from "field present but empty" (an explicit
**clear**). New semantics for `system.task`, walking events oldest→newest as today:

- `task`:
  - key **absent** → leave `currentTask` unchanged (as today).
  - key present, **non-empty after trim** → set `currentTask` to it (as today).
  - key present, **empty/whitespace** (`""`, `"   "`) → **clear**: set `currentTask = null`.
- `project`: same three-way rule (absent = unchanged; non-empty = set; empty = clear → `currentProject = null`).
- `deadline`: **unchanged** from today (only set on non-empty; do not add clearing — out of scope here).

Because the Phase-15/16 fallbacks run *after* this loop (`if (currentTask === null) currentTask =
taskFromBranch(...)`, `if (currentProject === null) currentProject = activeRepo`), a cleared task correctly
falls back to the branch-derived task (→ `null` on `main`) and a cleared project to the active repo. **That
is the intended behavior** — clearing an explicit task on a feature branch reveals the branch task; on
`main` it goes empty.

**UI (`src/ui/page.ts`):** in the **Now** card, when `currentTask` is present, render a small **"Clear
task"** button that `POST`s `/api/emit` with `{ source: "system", type: "system.task", data: { task: "" } }`
(the same fetch pattern the existing block/task buttons use), then refreshes. `system.task` is already on
the `POST /api/emit` whitelist — **do not change the whitelist**. No server change is required; verify the
existing `/api/emit` accepts `data.task === ""` (the emit CLI/store only checks the type prefix, so an empty
`task` is a valid event — confirm and, if some layer rejects empty data, note it, do not widen scope).

Optional (only if trivial): a matching "Clear" affordance for project is **not** required — task is the one
that hurt.

---

## 3. Files to create / edit

### Edit
- `src/state/builder.ts` — Part 1 (`fileStillExists` + existence filter in the `editor.save` loop) and
  Part 2 (three-way clear semantics for `system.task` `task`/`project`).
- `src/ui/page.ts` — a "Clear task" button in the Now card that POSTs an empty `system.task`.
- `src/state/builder.test.ts` — tests for both parts (see §4).

### Do NOT edit
Planner, Worker, Executor, Synth, Autopilot, Advisor, infer, config, the watchers, the event store, or the
`/api/emit` whitelist.

---

## 4. Tests (`bun test`, OFFLINE) — required

Use the existing `builder.test.ts` harness (`setExecutiveHome` + `writeRawEvent` + `buildState`).

**Part 1 — currentFile existence:**
1. **Stale file dropped:** write `editor.save{path:"does-not-exist-xyz.ts"}` (highest seq) and
   `editor.save{path:"<a real file that exists>"}` (lower seq) → `currentFile` is the **real** file, and the
   nonexistent path is absent from `recentFiles`. (Create a real temp file under the test's home/cwd to
   point at, or reference a path you `writeFileSync` first.)
2. **All stale → null:** the only `editor.save` points at a nonexistent path → `currentFile === null`,
   `recentFiles === []`.
3. **Existing file kept:** an `editor.save` for a file you created on disk → it is `currentFile` (no
   regression).

**Part 2 — clearable task:**
4. **Empty task clears:** `system.task{task:"fix login"}` (seq 1) then `system.task{task:""}` (seq 2), on a
   non-feature branch context → `currentTask === null`.
5. **Absent task key leaves task unchanged:** `system.task{task:"fix login"}` then
   `system.task{project:"myshi"}` (no `task` key) → `currentTask === "fix login"`, `currentProject === "myshi"`.
6. **Clear then branch fallback:** with git events putting the branch at `feat/dark-mode`,
   `system.task{task:"old"}` then `system.task{task:""}` → `currentTask === "dark mode"` (branch fallback,
   Phase 15) — proves clear defers to the fallback, not to the stale explicit task.
7. **Whitespace-only clears:** `system.task{task:"   "}` after a real task → `currentTask === null`.

All existing tests must still pass. No test may hit the network. Part 1 tests must create/point at real
on-disk paths (a temp file) — do not mock `existsSync`.

---

## 5. Acceptance criteria (Claude will verify ALL by running them)

- [ ] `bun run typecheck` passes; `bun test` passes offline.
- [ ] **Live currentFile prune:** with a polluted log whose newest `editor.save` is a deleted temp file,
      `build-state` → `report` shows `editing nothing` (or the newest **existing** file), and
      `state.json.currentFile` is not the deleted path. Verified live against a scripted log.
- [ ] **Live clear task:** `emit system system.task '{"task":"x"}'` → `report` shows the task; then
      `emit system system.task '{"task":""}'` → `build-state`/`report` shows **no task** (on `main`).
      Verified live.
- [ ] **Clear defers to branch:** on a `feat/…` branch, clearing the explicit task reveals the branch task.
- [ ] **UI button:** the dashboard Now card shows a "Clear task" button when a task is present; clicking it
      clears the task (POST `/api/emit` empty `system.task`, then the card updates). Verified live via `ui`.
- [ ] No change to Planner/Worker/Executor/Synth/Autopilot/Advisor/infer/config/watchers/store/whitelist
      (git diff of those is empty).
- [ ] `.executive/` stays gitignored; only §3 files touched.

---

## 6. Deliverable

A commit containing §3's files + this doc. Do NOT commit `.executive/` runtime data. Hand back for review —
Claude runs every item in §5 (including live checks) and will NOT trust the self-report.

---

## 7. Design notes (rationale — not extra work)

- **Why disk-existence, not time-expiry:** "the file was deleted" is a crisp, deterministic signal;
  "the task is old" is not (real tasks span days). Existence keeps the builder rule-based and unsurprising.
- **Why keep-on-uncertainty:** dropping a real `currentFile` because `build-state` ran from an odd cwd would
  be worse than showing a slightly stale file. The check only removes files it can prove are gone.
- **Why reuse `system.task` for clearing:** the event log is the single source of truth; a clear is just an
  event, so it is inspectable, ordered, and reversible like everything else — no special mutable "clear"
  path, no new event type, no whitelist change.
