# Scope — Phase 3: State Builder (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context beyond Phases 1–2. Read
> `docs/scopes/phase-1-runtime.md`, `docs/scopes/phase-2-eventbus-watchers.md`, and `CLAUDE.md`
> first — this builds directly on the JSONL EventStore (`read`/`tail`) and the `watch` daemon.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **Primary OS: Windows 11 (Bun on
> Windows) — everything must work there.**

---

## 0. What this phase is (and is NOT)

Phases 1–2 give us a stream of events (`git.commit`, `git.branch_switch`, `editor.save`, plus manual
`emit`). **Phase 3 turns that raw event history into a compact, current snapshot** the future planner
and Claude Worker will read — WITHOUT ever loading the whole repo or calling an LLM.

Every ~30s (and on demand) we run **`build-state`**: read the event logs, derive a **`state.json`**
(small structured snapshot) and a **`context.json`** (a larger rollup for a future reasoning step),
and write them atomically.

**This is 100% rule-based. There is NO decision-making, NO "what should I do next", NO LLM here.**
That is Phase 4 (Planner) and Phase 5 (Worker). Phase 3 only *describes* the present.

**In scope:**
1. `src/state/types.ts` — `State` and `Context` interfaces.
2. `src/state/builder.ts` — `buildState(now?)` (pure derivation from events) + `writeState(...)`
   (atomic persist to `.executiveOS/state.json` / `.executiveOS/context.json`).
3. A one-shot **`build-state`** CLI command.
4. Periodic rebuild wired into the existing **`watch`** daemon (every `state.intervalMs`, default
   30000), plus one rebuild immediately at startup.
5. Config gets a `state` block; `loadConfig` merges it with defaults (Phase 1/2 configs still load).
6. Tests.

**NOT in scope (do not build — later phases):**
- ❌ Planner / "highest value action" / any decision logic (Phase 4).
- ❌ Any LLM / Claude / Qwen call, MCP, VSCode extension (Phase 4+).
- ❌ New watchers (terminal/github/calendar/discord/browser) — Phase 3 consumes ONLY the events that
  already exist. Do not add event sources.
- ❌ SQLite / Drizzle — **still JSONL**.
- ❌ No web server, no HTTP, no Elysia.
- ❌ Do NOT create `.executiveOS/claude.md` / `rules.md` / `planner.md` (Phase 4/5 artifacts).

If tempted to add any ❌ item: **STOP.**

---

## 1. Event vocabulary this phase reads

Derive state from these event types (all already producible via Phase 2 watchers or manual `emit`):

| Event type | Source | Data shape (relevant fields) | Feeds |
|---|---|---|---|
| `git.commit` | git | `{ sha, subject, branch }` | `git.lastCommit`, `git.branch` |
| `git.branch_switch` | git | `{ from, to }` | `git.branch` |
| `editor.save` | editor | `{ path, changeType }` | `currentFile`, `recentFiles` |
| `system.task` | system | `{ project?, task?, deadline? }` | `currentProject`, `currentTask`, `deadline` |
| `system.test_result` | system | `{ status: "passing" \| "failing" }` | `tests` |
| `system.blocked` | system | `{ reason? }` | `blocked`, `blockedReason` |
| `system.unblocked` | system | `{}` | clears `blocked` |

Rule: for each derived field, **the newest relevant event wins** (newest = highest `seq`). If no
relevant event exists, use the documented default (below). `system.*` types are set by manual `emit`
for now (a future phase may emit them automatically) — they must be valid types (prefixed `system.`).

---

## 2. `State` and `Context` types (`src/state/types.ts`)

```ts
export interface CommitInfo {
  sha: string;
  subject: string;
  ts: string;      // ISO timestamp of the git.commit event
}

export interface State {
  generatedAt: string;              // ISO, when this snapshot was built
  eventCount: number;               // total events across all sources
  lastEventTs: string | null;       // ts of the newest event, or null if none

  currentProject: string | null;    // from newest system.task.project, else null
  currentTask: string | null;       // from newest system.task.task, else null
  deadline: string | null;          // from newest system.task.deadline, else null

  currentFile: string | null;       // path from newest editor.save, else null
  recentFiles: string[];            // up to 5 distinct editor.save paths, newest first

  git: {
    branch: string | null;          // newest of (branch_switch.to) / (commit.branch)
    lastCommit: CommitInfo | null;  // from newest git.commit
  };

  tests: "passing" | "failing" | "unknown";   // newest system.test_result, else "unknown"
  blocked: boolean;                 // true if newest of blocked/unblocked is blocked; default false
  blockedReason: string | null;     // reason from that system.blocked, else null

  activity: {
    active: boolean;                 // true if lastEventTs within idleThresholdMs of `now`
    idleMs: number | null;          // now - lastEventTs in ms, or null if no events
  };
}

export interface Context {
  generatedAt: string;
  summary: string;                  // one-line human-readable rollup built from State (see §4)
  state: State;                     // the full snapshot embedded
  recentEvents: Array<{            // last N events across all sources, seq-ascending
    seq: number; ts: string; source: string; type: string; data: Record<string, unknown>;
  }>;
}
```

- `idleThresholdMs`: constant `5 * 60 * 1000` (5 min).
- `recentEvents` length: constant `RECENT_EVENTS = 20`.

---

## 3. `buildState` — pure derivation (`src/state/builder.ts`)

```ts
export function buildState(now?: Date): { state: State; context: Context };
```

- **Pure & deterministic:** reads events via the Phase 1 EventStore (`read(source)` for each source,
  or `tail`), takes an optional `now` (default `new Date()`) so tests can pin time. Does NOT write
  files. No randomness beyond `now`.
- Gather **all** events from the 4 logs, sort ascending by `seq` (tie-break `ts`) — reuse the same
  ordering as `tail`. From that ordered list:
  - `eventCount` = length; `lastEventTs` = last event's `ts` (or null).
  - Walk to find the **newest** event of each relevant type (highest seq) to fill the fields per §1.
  - `recentFiles`: iterate newest→oldest `editor.save`, collect distinct `path` values, keep first 5.
  - `git.branch`: newest between the latest `git.branch_switch.to` and the latest `git.commit.branch`
    (compare by seq — whichever event is newer wins).
  - `blocked`: look at the newest event among `system.blocked` / `system.unblocked`; blocked iff that
    newest one is `system.blocked`.
  - `activity.idleMs` = `now - lastEventTs` (ms, ≥0); `active` = `idleMs !== null && idleMs <= idleThresholdMs`.
- Build `Context.recentEvents` = last `RECENT_EVENTS` of the ordered list (seq-ascending), mapping to
  `{ seq, ts, source, type, data }`.
- Build `Context.summary` per §4.
- Missing/malformed `data` fields must not throw — treat as absent (use defaults). Guard every access
  (e.g. `typeof data.path === "string"`).

```ts
export function writeState(built: { state: State; context: Context }): void;
```

- Writes `.executiveOS/state.json` and `.executiveOS/context.json`, each pretty-printed
  (`JSON.stringify(x, null, 2) + "\n"`), **atomically** (write to a temp file in the same dir, then
  `renameSync` over the target — same technique as `seq.ts`). Ensure `.executiveOS/` exists first.

> Paths: add helpers to `src/paths.ts` — `statePath()` = `execRoot()/state.json`,
> `contextPath()` = `execRoot()/context.json`. Follow the existing forward-slash style in that file.

---

## 4. `summary` string (deterministic template)

Build a single line from `State`, e.g.:

```
On branch <branch|"?">, editing <currentFile|"nothing">; task: <currentTask|"none">;
tests <tests>; <blocked?"BLOCKED: "+reason : "not blocked">; <active?"active":"idle">.
```

Keep it one line, no newlines. Exact wording is up to you but it MUST be a pure function of `State`
(same State → same summary) and must mention: branch, currentFile, currentTask, tests, blocked,
active. This is a convenience field, not parsed by anything this phase.

---

## 5. Config additions (`src/config.ts`)

Extend `Config` (keep backward compatible — Phase 1/2 configs without a `state` key must still load):

```ts
state?: {
  intervalMs?: number;   // periodic rebuild cadence in the watch daemon; default 30000
};
```

- `defaultConfig()` sets `state: { intervalMs: 30000 }`.
- `loadConfig()` merges a missing `state` (and missing `state.intervalMs`) with the default — mirror
  exactly how the Phase 2 `watch` merge was done. Do NOT throw on a missing `state` key.

---

## 6. CLI: `build-state` (`src/index.ts`)

Add one command:

| Command | Behavior |
|---|---|
| `build-state` | `bootstrap()` → `buildState()` → `writeState(...)`. Print a concise summary line to stdout: the resolved `state.json` path and the `Context.summary`. Exit 0. On error, stderr + exit 1. |

- Existing `init` / `emit` / `tail` / `watch` / `--help` stay; update `--help` to include `build-state`.

---

## 7. Wire periodic rebuild into the `watch` daemon (`src/index.ts`)

In the `watch` command, after `manager.startAll()`:
- Do one rebuild immediately: `writeState(buildState())` (wrapped in try/catch — a rebuild failure
  logs to stderr and must NEVER crash the daemon).
- Start `setInterval(rebuild, config.state.intervalMs)` (default 30000). Print a startup line noting
  the state-rebuild cadence.
- On SIGINT shutdown: `clearInterval` for this timer too (alongside `manager.stopAll()`), so the
  process still exits cleanly.

> Keep it simple: a fixed-interval rebuild is fine. Do NOT rebuild on every event, and do NOT add a
> separate scheduler module — one `setInterval` in the daemon is the whole feature.

---

## 8. Housekeeping

- `.gitignore`: add `/.executiveOS/state.json` and `/.executiveOS/context.json` (derived runtime data,
  like the event logs — never committed). Match the existing `.executiveOS/...` ignore style.
- `bootstrap()` does **not** need to pre-create `state.json`/`context.json` (they are produced by
  `build-state`/`watch`). Do not change bootstrap for this.

---

## 9. Tests (`bun test`) — required

Isolate with `EXECUTIVE_HOME` = temp dir (as in Phases 1–2). Add a new test file
`src/state/builder.test.ts`. Cover:

1. **empty**: with no events, `buildState()` returns `eventCount: 0`, `lastEventTs: null`,
   `currentFile: null`, `recentFiles: []`, `git.branch: null`, `git.lastCommit: null`,
   `tests: "unknown"`, `blocked: false`, `activity.active: false`, `activity.idleMs: null`.
2. **currentFile / recentFiles**: append several `editor.save` events (some duplicate paths); assert
   `currentFile` is the newest path and `recentFiles` is the distinct newest-first list, length ≤ 5.
3. **git derivation**: append a `git.commit` then a `git.branch_switch`; assert `git.lastCommit`
   matches the commit and `git.branch` is the branch_switch `to` (newest wins by seq).
4. **newest-wins for system fields**: append `system.test_result{status:"failing"}` then later
   `system.test_result{status:"passing"}`; assert `tests === "passing"`. Append `system.blocked
   {reason:"x"}` then `system.unblocked`; assert `blocked === false`. Then append `system.blocked
   {reason:"y"}` last; assert `blocked === true` and `blockedReason === "y"`.
5. **system.task**: append `system.task{project:"P",task:"T",deadline:"tomorrow"}`; assert the three
   fields land in state.
6. **activity**: with a pinned `now`, an event whose ts is 10 min before `now` → `active: false`,
   `idleMs ≈ 600000`; an event 1 min before → `active: true`.
7. **malformed data doesn't throw**: write (via `emit`/append) an `editor.save` with `data: {}` (no
   `path`); `buildState()` must not throw and must skip it for `currentFile`.
8. **writeState round-trips**: `writeState(buildState())` creates valid JSON at `statePath()` and
   `contextPath()`; re-reading and `JSON.parse` succeeds; `context.state` deep-equals the written
   `state`; `context.recentEvents.length <= 20`.

Use `append({ source, type, data, seq? })` directly to construct event histories quickly.

---

## 10. Acceptance criteria (Claude will verify ALL by running them)

- [ ] `bun run typecheck` passes (strict), zero errors.
- [ ] `bun test` passes — all §9 tests green, and the existing Phase 1/2 suites still pass.
- [ ] Live CLI: in a temp `EXECUTIVE_HOME`, `init`, then a scripted set of `emit`s
      (`editor.save`, `git.commit`, `system.task`, `system.test_result`, `system.blocked`), then
      `build-state` → `state.json` exists, is valid JSON, and its fields match the emitted events
      (Claude drives this and asserts exact values).
- [ ] `context.json` exists, is valid JSON, embeds `state`, and `recentEvents` is seq-ordered.
- [ ] A Phase 1/2 `config.json` **without** a `state` key still loads (merged with default 30000).
- [ ] `executive watch` writes `state.json` at startup and refreshes it on its interval; a real
      `git commit` in the watched repo is reflected in a rebuilt `state.json` (Claude drives live,
      using a short `state.intervalMs` via config). Ctrl-C still exits without hanging and clears the
      rebuild timer.
- [ ] `state.json` / `context.json` are gitignored (verify with `git check-ignore`).
- [ ] No out-of-scope features (no planner, no LLM, no new watchers, no SQLite, no server, no
      `claude.md`/`rules.md`/`planner.md`).

---

## 11. Deliverable

A commit adding `src/state/types.ts`, `src/state/builder.ts`, `src/state/builder.test.ts`, the
`paths.ts`/`config.ts`/`index.ts`/`.gitignore` changes, and the `build-state` command + daemon wiring.
Leave this doc in place. Do NOT commit `.executiveOS/` runtime data (including `state.json`/`context.json`).
Hand back for review — Claude runs every item in §10, including a live `build-state` and a live
`watch` state-refresh against a temp git repo.
