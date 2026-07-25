# Scope — Phase 40: SQLite event storage (behind a config gate)

> **Audience:** implementer (has NO context from any conversation) + reviewer. Everything needed is here.
> **Author:** Claude (architect). **Repo root:** `C:/Users/yiw20/Programming/myshi/executive`
> **Runtime:** Bun + TypeScript (strict). `bun test` must stay green; `bun run typecheck` must stay green.
>
> **Do NOT read `CLAUDE.md` / `HANDOFF.md` / `GOTCHA.md`** — they are large and everything you need is in
> this spec. Work file by file; `grep` rather than reading whole files.

---

## 0. What this phase is (and is NOT)

ExecutiveOS stores every observed event as one JSON object per line in five JSONL files under
`.executive/events/{git,terminal,editor,system,screen}.jsonl`. That log is now **6,700+ events / 1.5 MB**,
and **every consumer re-reads all five files in full**:

- the State Builder rebuilds `state.json` on a **30-second timer** in the `watch`/`ui` daemon, and
- the dashboard rebuilds state **on every `GET /api/state` request** (a 5-second page refresh).

This phase adds a **SQLite-backed event store behind the existing interface**, selectable by config, plus a
one-shot migration command. The JSONL backend stays the default and stays fully working.

### CRITICAL — hard guardrails (a violation of any is a defect)

- **The event-append contract does not change.** `append` / `read` / `tail` keep their current exported
  names, signatures and semantics. The State Builder, watchers, Planner, agent tools, UI server and every
  other caller **must not need any change to their call sites** (two consumers that bypass the store and
  read files directly are re-routed in Job 2 — that is the only consumer change).
- **`seq` allocation does NOT move.** `nextSeq()` / `currentSeq()` in `src/events/seq.ts` and
  `.executive/meta.json` stay exactly as they are, for **both** backends. A backend only *stores and reads*
  events; it never invents a `seq`. (This keeps flipping the backend back and forth coherent.)
- **Default is unchanged behaviour.** A config with no `storage` block, and a config with
  `storage.backend: "jsonl"`, must behave **byte-identically to today**.
- **Migration is dry-run by default**, `--apply` is opt-in, and it **never deletes or rewrites the JSONL
  files** — they remain on disk as the backup. (Project rule: every action inspectable and reversible.)
- **No new npm dependency.** Use Bun's built-in `bun:sqlite` (`import { Database } from "bun:sqlite"`).
  Do **not** add Drizzle, better-sqlite3, or anything else to `package.json`.
- **Deterministic. NO LLM, no network** anywhere in this phase.

### Out of scope (do NOT build)

- No Drizzle ORM, no migration framework, no second table (one `events` table only).
- No change to event shape, event sources, or the five type prefixes.
- No querying features beyond what `read`/`tail` already offer (no date-range queries, no full-text search,
  no pagination API). Callers keep getting plain `ExecEvent[]`.
- No moving other `.executive/` artifacts (`state.json`, `plan.json`, `advisor.json`, `notifications.jsonl`,
  `conversation.jsonl`, `nudges.jsonl`, …) into SQLite. **Events only.**
- No automatic migration on startup, and no automatic backend switch. The owner runs `migrate-events
  --apply` and edits/toggles the config deliberately.
- No deletion of the JSONL backend, its code path, or its tests.

---

## 1. Files

**Job 1 — foundation (do this first, it defines the interface Job 2 uses):**

| File | Action |
|---|---|
| `src/events/backend.ts` | **NEW** — `EventBackend` interface + `getBackend()` factory |
| `src/events/jsonl-backend.ts` | **NEW** — today's file logic, moved behind the interface |
| `src/events/sqlite-backend.ts` | **NEW** — `bun:sqlite` implementation |
| `src/events/store.ts` | **EDIT** — becomes a thin dispatcher; adds `readSync`/`tailSync` |
| `src/events/backend.test.ts` | **NEW** — one test body run against **both** backends |
| `src/config.ts` | **EDIT** — add the `storage` block + backward-compatible merge |
| `src/paths.ts` | **EDIT** — add `eventDbPath()` |

**Job 2 — consumers + migration (needs Job 1 merged):**

| File | Action |
|---|---|
| `src/events/migrate.ts` | **NEW** — `migrateEventsToSqlite({apply})` |
| `src/events/migrate.test.ts` | **NEW** |
| `src/state/builder.ts` | **EDIT** — `readEventsSync` delegates to the store (≈6 lines) |
| `src/compact/compact.ts` | **EDIT** — read/write events through the backend |
| `src/bootstrap.ts` | **EDIT** — init the active backend; add the missing `"screen"` source |
| `src/index.ts` | **EDIT** — new `migrate-events [--apply]` command + usage line |

Do not touch any other file.

---

## 2. Job 1 — the backend abstraction

### 2.1 `src/paths.ts`

Add, next to the other path helpers (they all build on `execRoot()`):

```ts
/** Absolute path to .executive/events.db (the SQLite event store, Phase 40). */
export function eventDbPath(): string {
  return execRoot() + "/events.db";
}
```

### 2.2 `src/config.ts`

`Config` is a plain interface with optional blocks; `loadConfig()` merges each missing block/field from
`defaultConfig()`. Follow the existing `state` block exactly as the pattern.

1. Add to `interface Config`, after the `state` block:

```ts
  /** Event storage backend (defaults applied when absent). */
  storage?: {
    /** "jsonl" (default) = five .jsonl files; "sqlite" = .executive/events.db. */
    backend?: "jsonl" | "sqlite";
  };
```

2. Add to `defaultConfig()`: `storage: { backend: "jsonl" }`.

3. Add to the merge in `loadConfig()`, mirroring the `state` merge:

```ts
  if (!parsed.storage) {
    parsed.storage = defaults.storage!;
  }
  parsed.storage.backend = parsed.storage.backend ?? defaults.storage!.backend!;
```

4. **Validate defensively:** if `parsed.storage.backend` is neither `"jsonl"` nor `"sqlite"`, fall back to
   `"jsonl"` and write one warning line to `process.stderr`. Never throw — a hand-edited config must not
   brick the runtime.

Do **not** add it to the dashboard Autonomy toggles (`readAutonomyConfig`/`updateAutonomyConfig`). Switching
storage is a deliberate `config.json` edit, like `autopilot.apply`.

### 2.3 `src/events/backend.ts` (NEW)

```ts
import type { EventSource, ExecEvent } from "./types.js";

/**
 * A place events are stored. Implementations are SYNCHRONOUS — the State Builder needs a
 * synchronous read, and both backends (file I/O, bun:sqlite) are natively sync.
 * A backend NEVER allocates `seq`; callers pass a fully-formed event.
 */
export interface EventBackend {
  /** Create files / schema if missing. Idempotent, safe to call repeatedly. */
  init(): void;
  /** Persist one fully-formed event. */
  append(event: ExecEvent): void;
  /** Every event of one source, oldest → newest (seq ascending). Missing store → []. */
  read(source: EventSource): ExecEvent[];
  /**
   * The last `n` events of one source, or merged across ALL sources when `source` is
   * omitted. Returned seq ascending (oldest → newest), same as today's `tail`.
   */
  tail(n: number, source?: EventSource): ExecEvent[];
  /** Replace every event of one source (used only by compaction). */
  replaceAll(source: EventSource, events: ExecEvent[]): void;
}

/** All five sources, in the order `tail()` merges them. */
export const ALL_SOURCES: EventSource[] = ["git", "terminal", "editor", "system", "screen"];

/**
 * The backend selected by config. Read config on EVERY call (cheap, and tests switch
 * EXECUTIVE_HOME between cases); cache only the underlying sqlite handle, keyed by db path.
 */
export function getBackend(): EventBackend { /* … */ }
```

`getBackend()` reads `loadConfig().storage?.backend`; anything other than `"sqlite"` → the JSONL backend.
**Never memoize the choice itself** — the tests (and the daemon, which re-reads config every tick) must see a
config change without a restart.

### 2.4 `src/events/jsonl-backend.ts` (NEW)

Move the existing logic out of `src/events/store.ts` unchanged in behaviour:

- `init()` — `mkdirSync(eventsDir(), {recursive:true})`; create an empty file per source when missing.
- `append(event)` — `ensureLogExists(source)` then `appendFileSync(eventLogPath(source), JSON.stringify(event) + "\n")`
  (one write call, as today's comment demands).
- `read(source)` — read the file, split on `\n`, skip blank lines, `JSON.parse` each; **a corrupt line must
  NOT crash the read** — skip it and write `Warning: skipping corrupt line <i+1> in <path>` to
  `process.stderr` (keep today's exact message). A legacy line with no `seq` gets `seq = 0`.
- `tail(n, source?)` — as today: single source → `read` then sort by `seq` asc (tie-break `ts` asc) and
  `slice(-n)`; no source → read all five, merge, same sort, `slice(-n)`.
- `replaceAll(source, events)` — write the whole file atomically: write to `path + "." + randomUUID()` then
  `renameOverwrite(tmp, path)` (import from `../fs-atomic.js`). **If the log file does not exist, no-op**
  (do not conjure an events dir). Trailing newline only when `events.length > 0`. This mirrors the private
  `writeJsonl` currently in `src/compact/compact.ts`.

### 2.5 `src/events/sqlite-backend.ts` (NEW)

```ts
import { Database } from "bun:sqlite";
```

- **Schema** (created by `init()`, idempotent):

```sql
CREATE TABLE IF NOT EXISTS events (
  seq    INTEGER PRIMARY KEY,
  id     TEXT    NOT NULL,
  ts     TEXT    NOT NULL,
  source TEXT    NOT NULL,
  type   TEXT    NOT NULL,
  data   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_source_seq ON events(source, seq);
```

  `seq INTEGER PRIMARY KEY` makes seq the rowid: unique, indexed, no renumbering on delete. `data` holds
  `JSON.stringify(event.data)`.

- Open the DB with `new Database(eventDbPath(), { create: true })` and run
  `db.exec("PRAGMA journal_mode = WAL")` once after opening (concurrent daemon writer + dashboard reader).
  **Cache the handle in a module-level `Map<string, Database>` keyed by the resolved path** so repeated calls
  do not reopen it, and so a test that changes `EXECUTIVE_HOME` gets a different handle.
- `append(event)` — a prepared `INSERT INTO events (seq,id,ts,source,type,data) VALUES (?,?,?,?,?,?)`.
- `read(source)` — `SELECT … WHERE source = ? ORDER BY seq ASC`, rows mapped back to `ExecEvent` with
  `data: JSON.parse(row.data)`. **A row whose `data` will not parse must not crash the read** — use `{}` and
  write one warning line to stderr (same defensive posture as the corrupt-JSONL-line rule).
- `tail(n, source?)` — `SELECT … [WHERE source = ?] ORDER BY seq DESC LIMIT ?` then **reverse** the rows, so
  the result is seq ascending. (This is the whole point of the phase: the DB does the work, not the process.)
- `replaceAll(source, events)` — inside `db.transaction(...)`: `DELETE FROM events WHERE source = ?` then
  insert each event.
- Missing DB file → `init()` creates it; `read`/`tail` on an empty table → `[]`.

### 2.6 `src/events/store.ts` (EDIT — the public API, unchanged for callers)

Keep every existing export and signature:

- `append(input)` stays `async`, keeps validating `isValidType(source, type)` and throwing the **same error
  message**, keeps `data = {}` default, keeps the optional `seq` override for tests, keeps building
  `{seq, id: crypto.randomUUID(), ts: new Date().toISOString(), source, type, data}` and **returns that
  event**. Only the persistence line changes: `getBackend().append(event)` (after `getBackend().init()`).
- `read(source)` stays `async` → `return getBackend().read(source)`.
- `tail(n, source?)` stays `async` → `return getBackend().tail(n, source)`.
- **NEW exports** (this is the only API addition):
  - `export function readSync(source: EventSource): ExecEvent[]`
  - `export function tailSync(n: number, source?: EventSource): ExecEvent[]`

  Both call the backend directly. They exist because `src/state/builder.ts` is synchronous.

### 2.7 Job 1 tests — `src/events/backend.test.ts`

Follow the existing test conventions in `src/events/store.test.ts` (a temp `EXECUTIVE_HOME` per suite via
`process.env.EXECUTIVE_HOME`, `beforeEach` cleanup, `bun:test`'s `describe/it/expect`).

Write **one shared test body** and run it against both backends via a loop
(`for (const backend of ["jsonl", "sqlite"] as const)`), writing a `config.json` with that
`storage.backend` into the temp home before each case. Every criterion in §5.1 must be covered for **both**.

---

## 3. Job 2 — consumers + migration

### 3.1 `src/state/builder.ts`

It currently has a private `readEventsSync(source)` that opens `eventLogPath(source)` and parses lines
itself — i.e. it bypasses the store entirely. Replace **its body** with a delegation:

```ts
function readEventsSync(source: EventSource): ExecEvent[] {
  return readSync(source);            // from "../events/store.js"
}
```

Keep the function (call sites unchanged) and keep the "never crash the builder" behaviour — the backends
already skip corrupt records. Remove the now-unused `eventLogPath` import **only if nothing else in the file
uses it** (check with grep; `execRoot`, `statePath`, `contextPath` are used elsewhere).

### 3.2 `src/compact/compact.ts`

`runCompaction` currently calls private `readJsonl(eventLogPath(src))` / `writeJsonl(...)`. Re-route:

- reads → `readSync("screen")` / `readSync("system")` (from `../events/store.js`),
- writes → `getBackend().replaceAll("screen", kept)` / `replaceAll("system", kept)`,
- delete the now-unused private `readJsonl`/`writeJsonl` **only if nothing else uses them**,
- **backup step:** today it copies the two `.jsonl` files + `advisor.json` into `.executive/backup-<ts>/`.
  It must now back up **whatever the active backend actually stores**: when the backend is `sqlite`,
  `copyFileSync(eventDbPath(), backupDir + "/events.db")` instead of the two jsonl files (still copy
  `advisor.json` in both cases). Skip any source file that does not exist, exactly as today.

Everything else in `compact.ts` (the pure `compactScreenEvents` / `compactNoteEvents` /
`compactAdvisorStore`, dry-run default, `seq` never renumbered) is **unchanged**.

### 3.3 `src/bootstrap.ts`

- Its `SOURCES` array is `["git","terminal","editor","system"]` and is **missing `"screen"`** — add it (the
  screen log is currently created lazily on first append).
- After the existing directory/file creation, call `getBackend().init()` so a home configured for sqlite gets
  its schema at `init` time. Keep creating the empty JSONL files unconditionally — they are harmless, and
  they keep a flip back to `"jsonl"` working.
- `bootstrap()` must stay **idempotent** (running twice never errors or loses data).

### 3.4 `src/events/migrate.ts` (NEW)

```ts
export interface MigrationReport {
  mode: "dry-run" | "apply";
  /** Per source: how many events were read from JSONL. */
  read: Record<EventSource, number>;
  /** How many rows were (or would be) inserted. */
  inserted: number;
  /** Rows already present in the DB with the SAME id — a re-run, not a problem. */
  alreadyPresent: number;
  /** seq collisions: DB already holds this seq with a DIFFERENT id. Must be reported. */
  conflicts: Array<{ seq: number; existingId: string; incomingId: string }>;
  dbPath: string;
}

export function migrateEventsToSqlite(opts?: { apply?: boolean }): MigrationReport;
```

Behaviour:

1. Read all five JSONL logs **directly from disk** (not via `getBackend()` — the active backend may already
   be sqlite; this command's whole job is to move JSONL → DB). Reuse the JSONL backend's reader by
   instantiating it explicitly rather than duplicating the parse loop.
2. Open/`init()` the SQLite DB at `eventDbPath()`.
3. For each event in **seq-ascending order across all sources**: if a row with that `seq` exists, compare
   `id` — same → `alreadyPresent++`; different → push to `conflicts` and skip. Otherwise insert
   (apply mode) or just count (dry-run).
4. **Dry-run performs no writes at all** — it may open/create the DB file to inspect it, but must not insert.
5. Apply mode wraps all inserts in a single `db.transaction(...)`.
6. **After a successful apply**, if `max(migrated seq) > currentSeq()`, write
   `.executive/meta.json` = `{lastSeq: <max>}` so the shared seq counter can never hand out a used number.
   Write it atomically (temp + `renameOverwrite`, from `../fs-atomic.js`).
7. **Never deletes or rewrites any `.jsonl` file.** They are the backup.
8. Never throws on a corrupt JSONL line (the reader already skips it).

### 3.5 `src/index.ts` — the CLI

Add a `migrate-events` case to the existing hand-rolled `switch` (copy the shape of the `compact` case) and
one line to `printUsage()`:

```
bun run src/index.ts migrate-events [--apply]   # copy the JSONL event logs into .executive/events.db
```

Printed output must include, per source, `read` counts; `inserted`; `alreadyPresent`; the `dbPath`; and the
mode. **If `conflicts.length > 0`, print each conflict and exit with code 1** (a silent partial migration is
the failure mode this phase must not have). On success in dry-run, print the reminder that nothing was
written and that `--apply` performs it. On success in apply mode, print the follow-up instruction:
set `"storage": { "backend": "sqlite" }` in `.executive/config.json` and restart the daemon.

---

## 4. Performance note (why this phase exists)

With `storage.backend: "sqlite"`, `tail(20)` must become a `LIMIT 20` query, **not** a full read + sort in
JS. The State Builder still legitimately reads everything (it derives from the whole history), so the win
there is parse cost, not I/O shape — that is expected and fine. Do **not** add caching, incremental state, or
a materialized view; those are separate phases.

---

## 5. Acceptance criteria

Every criterion must be covered by a test, and the reviewer will run them.

### 5.1 Backend parity — run each of these against **both** `jsonl` and `sqlite` (§2.7)

1. **Round-trip.** `append` three events across two sources, then `read(source)` returns them oldest→newest
   with `seq`/`id`/`ts`/`source`/`type`/`data` intact (including a nested/unicode `data`, e.g.
   `{ msg: "ติดอยู่ รอ API key", n: 3 }`).
2. **`read` of an unknown/empty source → `[]`** (no throw, no file/table created as a side effect of reading).
3. **`tail(n, source)`** returns the last `n` of that source, **seq ascending**.
4. **`tail(n)` with no source** merges all sources and returns the last `n` **seq ascending** — verify with
   events interleaved across `git`/`system`/`screen` whose seqs interleave too.
5. **`tail(n)` where n > total** returns everything, seq ascending.
6. **`replaceAll(source, subset)`** leaves that source holding exactly `subset`, and **leaves the other
   sources untouched**.
7. **Corrupt record tolerance.** JSONL: a garbage line in the middle of the file → the other events still
   read back. SQLite: a row whose `data` is not valid JSON (insert it directly with raw SQL) → that event
   reads back with `data: {}` and the others are intact. Neither throws.
8. **`append` validation is unchanged:** `append({source:"git", type:"system.task"})` rejects with the
   existing message (`Invalid type "system.task" for source "git". …`) on **both** backends.

### 5.2 Config gate

9. **No `storage` block** in `config.json` → `loadConfig().storage.backend === "jsonl"`, and an `append`
   writes to `.executive/events/<source>.jsonl` with **no `events.db` created**.
10. **`storage.backend: "sqlite"`** → an `append` writes a row into `.executive/events.db` and **appends
    nothing** to the JSONL files.
11. **Garbage backend value** (`"postgres"`) → falls back to `"jsonl"`, warns on stderr, does not throw.

### 5.3 Consumers

12. **State Builder over SQLite.** With `storage.backend: "sqlite"`, append a `git.branch_switch` +
    `system.blocked` via `append`, then `buildState()` derives the same `state.blocked`/`git.branch` it
    derives from the equivalent JSONL home. (Assert the two states are equal field-for-field.)
13. **All existing tests stay green.** In particular `src/state/builder.test.ts` writes raw JSONL files by
    hand with no config — criterion 9 guarantees those homes stay on the JSONL backend.
14. **Compaction over SQLite.** With `storage.backend: "sqlite"`, seed screen events with repeated
    normalized titles, run `runCompaction({apply:true})` → the DB holds only the survivors, `seq` values are
    **unchanged** (never renumbered), and the backup dir contains `events.db`.
15. **`bootstrap()` twice** on a sqlite home → no error, one table, zero rows lost.

### 5.4 Migration

16. **Dry-run writes nothing.** A home with 5 JSONL events → `migrateEventsToSqlite()` reports
    `inserted: 5`, and the DB has **0 rows**.
17. **Apply migrates everything.** `--apply` → DB row count equals the total JSONL event count, and for a
    sample event every field matches (including `data` deep-equality).
18. **Idempotent.** Running apply twice → the second run reports `alreadyPresent` = total, `inserted: 0`,
    and the row count is unchanged.
19. **Conflict is reported, not swallowed.** Pre-insert a row with `seq: 3` and a **different** `id`, then
    migrate a JSONL event with `seq: 3` → that event appears in `conflicts[]`, is **not** inserted, and the
    other events still migrate.
20. **`meta.json` is advanced.** After apply, `currentSeq()` ≥ the maximum migrated `seq`.
21. **JSONL files are untouched by migration** — byte-identical before and after `--apply`.

### 5.5 Hygiene

22. `bun run typecheck` clean. `bun test` all green (existing count is **736**; it must only go up).
23. `git diff --stat` touches **only** the files listed in §1.
24. No new entry in `package.json` `dependencies`/`devDependencies`.

---

## 6. Sabotage check (run it, do not just claim it)

The point of this check is that it is the one claim a reviewer cannot verify by reading the diff. Break the
code, run the suite, confirm the expected tests go red, then **restore**:

1. Make `getBackend()` always return the JSONL backend → criteria 10, 12, 14 go red.
2. Make the sqlite `tail()` drop its `ORDER BY seq DESC` reversal (return rows as fetched) → criteria 3, 4 go red.
3. Make `migrateEventsToSqlite` use `INSERT OR IGNORE` without the id comparison → criterion 19 goes red.
4. Make dry-run insert rows → criterion 16 goes red.

Report which tests failed for each, and confirm the suite is green again afterwards.

---

## 7. Notes for the implementer

- **Windows.** Paths are built by `"/"`-concatenation throughout this repo; keep that style. Never use a
  bare `renameSync` on an existing file — always `renameOverwrite` from `src/fs-atomic.ts` (a plain rename
  onto an existing file is only probabilistically atomic on Windows).
- **Tests set `process.env.EXECUTIVE_HOME`** to a temp dir; every path helper reads it at call time, so never
  cache a resolved path at module scope. The sqlite handle cache **must** be keyed by the resolved db path
  for the same reason, and should be closable/clearable so a test can delete its temp dir.
- The `screen` source exists (five sources, not four). `src/events/store.ts`'s `tail()` already lists all
  five — copy that list into `ALL_SOURCES` and use it everywhere instead of re-declaring it.
- Do not "improve" unrelated code you pass through. If you spot a real bug outside this scope, write it in
  your final report instead of fixing it.
