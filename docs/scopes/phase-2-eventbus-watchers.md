# Scope — Phase 2: Event Bus + `seq` + Watchers (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context beyond Phase 1. Read Phase 1
> (`docs/scopes/phase-1-runtime.md`) and `CLAUDE.md` first — this builds directly on the Phase 1
> EventStore and CLI.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **Primary OS: Windows 11 (Bun on Windows) — everything must work there.**

---

## 0. What this phase is (and is NOT)

Phase 1 gave us manual event storage (`emit` by hand). **Phase 2 makes events flow in automatically**
via watchers, routed through an **Event Bus**, and fixes the timeline-ordering bug by adding a
monotonic **`seq`** to every event.

**In scope:**
1. Add `seq` (global monotonic counter) to the event model; make `tail` order by it.
2. An in-process **EventBus** (publish/subscribe) as the seam between sources and storage.
3. A **StoreSink** that is the single subscriber persisting bus events via the EventStore.
4. A **Watcher** interface + **WatcherManager** (start/stop all watchers).
5. Two concrete watchers: **GitWatcher** (poll-based) and **FsWatcher** (file changes).
6. A long-running **`executive watch`** CLI command (the daemon) + config for it.

**NOT in scope (do not build — later phases):**
- ❌ Terminal / GitHub / Calendar / Discord / Browser watchers (Phase 3+). Terminal ingest stays the
  existing manual `emit terminal ...` for now.
- ❌ State builder / `state.json` / `context.json` (Phase 3).
- ❌ Planner, any LLM/Claude/Qwen call, MCP, VSCode extension (Phase 4+).
- ❌ SQLite / Drizzle — **still JSONL** this phase.
- ❌ No web server, no HTTP, no Elysia.

If tempted to add any ❌ item: **STOP.**

---

## 1. `seq` — global monotonic sequence (fixes the Phase 1 `tail` bug)

**Problem being fixed:** Phase 1 `tail()` sorts only by ms-resolution `ts`; events in the same
millisecond across sources tie-break by source-iteration order, not real order.

**Change the event model** (`src/events/types.ts`):
```ts
export interface BaseEvent {
  seq: number;         // NEW: global monotonic counter, unique & increasing across ALL sources, starts at 1
  id: string;
  ts: string;
  source: EventSource;
  type: string;
  data: Record<string, unknown>;
}
```

**Sequence allocation** — add `.executive/meta.json`:
```json
{ "lastSeq": 42 }
```
- New module `src/events/seq.ts`:
  - `nextSeq(): number` — reads `meta.json` (`lastSeq`, default 0 if missing/empty), increments,
    writes it back atomically (write to a temp file then rename, to avoid a torn write), returns the new value.
  - `currentSeq(): number` — reads `lastSeq` without incrementing (0 if none).
- `bootstrap()` must create `meta.json` with `{ "lastSeq": 0 }` if missing (never clobber existing).
- **Concurrency assumption:** exactly one writer at a time. In practice the `watch` daemon is the writer;
  manual `emit` from a second process while the daemon runs is a known unsupported edge (document it in a
  comment, don't engineer around it this phase).

**`append()` change** (`src/events/store.ts`): assign `seq = nextSeq()` (unless a `seq` is explicitly
passed in — allow an optional `seq?: number` on the input for testing). Keep everything else identical.

**`read()` robustness:** a legacy line without `seq` must not crash; default its `seq` to `0`.

**`tail()` change:** sort by `seq` ascending (primary), `ts` ascending (tie-break only if seq missing),
then `slice(-n)`. This replaces the ts-only sort. The single-source path also returns by seq order
(already correct since same-source appends are monotonic, but keep it consistent).

---

## 2. EventBus (`src/bus.ts`)

A tiny in-process publish/subscribe. This is the architectural seam so new watchers plug in without
touching storage or (later) the planner.

```ts
export interface EventInput {
  source: EventSource;
  type: string;
  data?: Record<string, unknown>;
}

export type BusHandler = (e: EventInput) => void | Promise<void>;

export class EventBus {
  publish(e: EventInput): void;          // fire-and-forget to all subscribers, in registration order
  subscribe(handler: BusHandler): () => void;  // returns an unsubscribe function
}
```
Rules:
- No external deps — implement with a simple handler array (do not import Node's `EventEmitter`; keep it typed).
- `publish` invokes handlers in order; if a handler throws/rejects, catch it and write a warning to
  stderr (`Bus handler error: ...`) — one bad handler must not stop the others or crash the daemon.
- Keep it ~40 lines. No wildcard topics, no priorities — YAGNI this phase.

---

## 3. StoreSink (`src/sink.ts`)

The **single** subscriber that persists bus events.

```ts
// Subscribe a sink that appends every published EventInput via EventStore.append().
export function attachStoreSink(bus: EventBus): () => void;  // returns unsubscribe
```
- Internally calls the Phase 1 `append(...)` (which now assigns `seq`).
- Appends are serialized: process one event fully before the next (the daemon has a single sink; if
  `publish` is sync and `append` uses `appendFileSync`, this is naturally serial — keep it that way).
- On append error, log to stderr and continue (never crash the daemon).

---

## 4. Watcher interface + WatcherManager (`src/watchers/index.ts`)

```ts
export interface Watcher {
  readonly name: string;             // e.g. "git", "fs"
  start(bus: EventBus): Promise<void> | void;  // begin watching; publish events to bus
  stop(): Promise<void> | void;      // clean up timers/handles; idempotent
}

export class WatcherManager {
  constructor(bus: EventBus, watchers: Watcher[]);
  startAll(): Promise<void>;
  stopAll(): Promise<void>;   // must be safe to call once on shutdown
}
```
- Watchers receive the bus and `publish` to it — they never touch the EventStore directly.
- `stopAll` must clear every interval/handle so the process can exit cleanly.

---

## 5. GitWatcher (`src/watchers/git.ts`) — poll-based, reliable, testable

Watches a git repository for **new commits** and **branch switches** by polling (no native fs hooks —
polling is the reliable cross-platform choice, especially on Windows).

- Config: `repoPath` (absolute) and `pollMs` (default 5000).
- On `start`: record the current `HEAD` sha and current branch as the baseline (do NOT emit for the
  existing state).
- Every `pollMs`, run git via `Bun.spawn`/`Bun.$`:
  - `git -C <repoPath> rev-parse HEAD` → if sha changed since last seen, emit
    `git.commit` with `data: { sha, subject, branch }` (get subject via
    `git -C <repoPath> log -1 --pretty=%s`). If several commits landed at once, emitting one
    `git.commit` for the new HEAD is acceptable this phase (document it).
  - `git -C <repoPath> rev-parse --abbrev-ref HEAD` → if branch changed, emit
    `git.branch_switch` with `data: { from, to }`.
- If `repoPath` is not a git repo or git fails, log a warning once and keep polling (don't crash).
- `stop` clears the interval.

**Types must be valid** (`git.` prefix): `git.commit`, `git.branch_switch`.

## 6. FsWatcher (`src/watchers/fs.ts`) — file changes → editor events

Watches configured directories for file changes and emits editor events.

- Config: `paths` (array of absolute dirs to watch) and `debounceMs` (default 300).
- Use Bun's `fs.watch(dir, { recursive: true })` for each path.
- On a change event, **debounce per file path** (collapse rapid saves within `debounceMs` into one),
  then emit `editor.save` with `data: { path, changeType }` where `changeType` is `"change" | "rename"`.
- **Ignore** paths under `.git/`, `node_modules/`, and the `.executive/` dir itself (avoid feedback
  loops where writing the event log triggers another event). Make the ignore list a constant.
- `stop` closes all watchers and clears debounce timers.

> Note on Windows: `fs.watch` recursive is supported on Windows; still guard against the watcher firing
> for its own log writes via the ignore list above.

---

## 7. Config additions (`src/config.ts`)

Extend `Config` (keep backward compatible — existing Phase 1 configs must still load; supply defaults
for new fields when absent):
```ts
export interface Config {
  version: 1;
  createdAt: string;
  timezone: string;
  watch: {
    git:  { enabled: boolean; repoPath: string; pollMs: number };   // repoPath default: process.cwd()
    fs:   { enabled: boolean; paths: string[]; debounceMs: number }; // paths default: [process.cwd()/src]
  };
}
```
- `defaultConfig()` fills sensible defaults (git.enabled true, pollMs 5000; fs.enabled true,
  paths `[<cwd>/src]`, debounceMs 300).
- `loadConfig()` must **merge missing `watch` fields with defaults** so a Phase 1 config (no `watch`
  key) still works — do not throw on missing new fields.

---

## 8. CLI: `executive watch` (`src/index.ts`)

Add one command:

| Command | Behavior |
|---|---|
| `watch` | Start the daemon: bootstrap → build EventBus → attach StoreSink → build enabled watchers from config → `startAll()`. Print a startup line listing active watchers and the resolved `.executive` path. Run until SIGINT (Ctrl-C). On SIGINT: `stopAll()`, flush, print "stopped", exit 0. |

- While running, print a concise line to **stdout** for each persisted event (e.g.
  `#<seq> <ts> <type> <short-data>`), and mirror full events to a rolling log file in
  `.executive/logs/watch-<date>.log`. Keep logging lightweight.
- Existing `init` / `emit` / `tail` / `--help` stay; update `--help` text to include `watch`.
- `emit` continues to work and now also gets a `seq` (via the same `append`).

---

## 9. Tests (`bun test`) — required

Isolate with `EXECUTIVE_HOME` = temp dir (as in Phase 1). Cover:

1. **seq**: `nextSeq()` returns strictly increasing ints starting at 1; persists across calls (reads
   back from `meta.json`); `bootstrap` creates `meta.json` = `{lastSeq:0}` and is idempotent.
2. **append assigns seq**: two appends across different sources get seq 1 then 2; stored events contain them.
3. **tail orders by seq**: append to git, then editor, then system (fast, same ms possible); `tail(3)`
   returns them in append order by seq — assert the exact `seq` sequence `[1,2,3]` and matching types,
   not just membership. (This is the Phase 1 bug; the test must fail on ts-only sorting.)
4. **read tolerates legacy line without seq**: write a valid JSON line missing `seq`, then a normal
   append; `read` returns both, legacy one has `seq === 0`, no throw.
5. **EventBus**: `publish` reaches all subscribers in order; `unsubscribe` stops delivery; a throwing
   handler doesn't prevent later handlers from running.
6. **StoreSink**: publishing an `EventInput` to a bus with an attached sink results in exactly one
   persisted event in the right log with a `seq`.
7. **WatcherManager**: a fake in-memory watcher's `start`/`stop` are invoked by `startAll`/`stopAll`;
   `stopAll` is safe and clears state.
8. **GitWatcher (integration, temp git repo)**: create a temp repo, `start` the watcher with a short
   `pollMs`, make a commit, wait one poll cycle, assert a `git.commit` event was published with the new
   sha; then switch branch and assert `git.branch_switch`. Use real `git`. Keep timing tolerant (poll a
   few cycles / await with a small timeout helper). If `git` is unavailable in the test env, the test
   may skip with a clear message — but it must be present and pass where git exists (it does here).

> FsWatcher automated tests are timing-flaky across OSes; a lightweight test that touches a file and
> asserts a debounced `editor.save` within a timeout is welcome but may be marked skippable. Do NOT
> block the suite on fs.watch timing.

---

## 10. Acceptance criteria (Claude will verify ALL by running them)

- [ ] `bun run typecheck` passes (strict), zero errors.
- [ ] `bun test` passes — all §9 tests green (GitWatcher integration included).
- [ ] `init` now also creates `.executive/meta.json` = `{"lastSeq":0}`; idempotent.
- [ ] `emit` events now carry an increasing `seq`; `tail` prints them in `seq` order.
- [ ] A Phase 1 `config.json` **without** a `watch` key still loads (merged with defaults) — verify by
      hand-writing an old-style config then running a command.
- [ ] `executive watch` starts, lists active watchers, and — in a temp git repo configured as
      `watch.git.repoPath` — a real `git commit` produces a `git.commit` event line and a persisted
      event (Claude will drive this live). Ctrl-C stops cleanly (exit 0), timers cleared (process exits,
      doesn't hang).
- [ ] Writing to `.executive/` (the log itself) does NOT cause the FsWatcher to emit (no feedback loop).
- [ ] No out-of-scope features (no terminal/github/calendar watcher, no state builder, no planner, no
      LLM, no SQLite, no server).

---

## 11. Deliverable

A commit adding `src/bus.ts`, `src/sink.ts`, `src/events/seq.ts`, `src/watchers/*`, the `seq`/config/CLI
changes, and tests. Leave this doc in place. Do NOT commit `.executive/` runtime data. Hand back for
review — Claude runs every item in §10, including a live `watch` session against a temp git repo.
