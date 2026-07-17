# Scope — Phase 1: Runtime Skeleton (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

ExecutiveOS is an event-driven personal assistant runtime. **Phase 1 is ONLY the plumbing that stores events.** There is deliberately **no AI, no watchers, no planner, no state builder** in this phase — those are later phases. Do not add them.

Phase 1 goal: a runtime that can **initialize its data directory**, **append events to JSONL logs**, and **read them back** — driven by a small CLI so it can be tested end-to-end by hand.

If you are tempted to add: file watchers, git hooks, a scheduler, an LLM call, SQLite, a web server, or a planner — **STOP. Out of scope.**

---

## 1. Tech + project setup

- **Runtime:** Bun (latest). Language: TypeScript (strict).
- **No external deps** beyond Bun's built-ins for Phase 1. (No Elysia, no Drizzle, no SQLite yet — those come later.) Dev-only deps like `typescript` and `@types/bun` are fine.
- Storage format this phase: **JSONL files** (one JSON object per line). SQLite is a later phase.

### Files to create
```
executive/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # CLI entry point
│   ├── config.ts           # load/validate config.json (with defaults)
│   ├── paths.ts            # resolves .executiveOS/ paths
│   ├── events/
│   │   ├── types.ts        # Event type definitions
│   │   ├── store.ts        # EventStore: append + read events (JSONL)
│   │   └── store.test.ts   # unit tests (bun test)
│   └── bootstrap.ts        # ensures .executiveOS/ dir structure exists
└── .executiveOS/             # created AT RUNTIME by `init`, NOT committed
    ├── config.json
    ├── events/
    │   ├── git.jsonl
    │   ├── terminal.jsonl
    │   ├── editor.jsonl
    │   └── system.jsonl
    └── logs/
```
> `.executiveOS/` runtime data is gitignored already. Do not commit it. Do commit `src/`, `package.json`, `tsconfig.json`.

### package.json requirements
- `"type": "module"`
- Scripts:
  - `"executive": "bun run src/index.ts"` (so `bun run executive -- <cmd>` works)
  - `"test": "bun test"`
  - `"typecheck": "tsc --noEmit"`
- `bin` mapping `"executive": "src/index.ts"` is optional; the CLI is invoked via `bun run src/index.ts <cmd>` in tests.

### tsconfig.json requirements
- `"strict": true`, `"module": "ESNext"`, `"moduleResolution": "bundler"`, `"target": "ESNext"`, `"types": ["bun-types"]`, `"noUncheckedIndexedAccess": true`.

---

## 2. Event model (`src/events/types.ts`)

Define a canonical event. Every event is one JSON object on one line.

```ts
// The four event sources = the four jsonl files.
export type EventSource = "git" | "terminal" | "editor" | "system";

// Base fields present on EVERY event.
export interface BaseEvent {
  id: string;          // unique id (use crypto.randomUUID())
  ts: string;          // ISO-8601 UTC timestamp, e.g. "2026-07-17T09:14:03.211Z"
  source: EventSource; // which log it belongs to
  type: string;        // event type, namespaced by source, e.g. "git.commit"
  data: Record<string, unknown>; // free-form payload; shape depends on type
}

export type ExecEvent = BaseEvent;
```

Rules:
- `type` MUST be prefixed with its source + `.` (e.g. `git.commit`, `terminal.command`, `editor.save`, `system.note`). Provide a helper `isValidType(source, type)` that checks the prefix matches the source.
- Do NOT over-model `data` in Phase 1 — keep it `Record<string, unknown>`. Typed payloads come later.

---

## 3. Paths (`src/paths.ts`)

- Export a function `execRoot(): string` returning the absolute path to the `.executiveOS/` directory.
  - Default: `<current working directory>/.executiveOS`.
  - Overridable via env var `EXECUTIVE_HOME` (absolute path). This is REQUIRED — tests rely on it to use a temp dir.
- Export helpers: `configPath()`, `eventsDir()`, `logsDir()`, `eventLogPath(source: EventSource)` — all derived from `execRoot()`.

---

## 4. Bootstrap (`src/bootstrap.ts`)

- Export `async function bootstrap(): Promise<void>` that:
  - Creates `.executiveOS/`, `.executiveOS/events/`, `.executiveOS/logs/` if missing (recursive, idempotent).
  - Creates each of the 4 empty `events/*.jsonl` files if missing (empty file, do NOT overwrite existing).
  - Writes `config.json` with defaults **only if it does not already exist** (never clobber an existing config).
- Idempotent: running it twice must not error or lose data.

---

## 5. Config (`src/config.ts`)

- Shape:
  ```ts
  export interface Config {
    version: 1;
    createdAt: string;   // ISO timestamp, set once at init
    timezone: string;    // default "Asia/Bangkok"
  }
  ```
- `defaultConfig(): Config` returns defaults (`version: 1`, `createdAt` = now, `timezone: "Asia/Bangkok"`).
- `loadConfig(): Promise<Config>` reads `config.json`. If the file is missing → throw a clear error telling the user to run `init`. If JSON is malformed → throw a clear error naming the file. Do not silently swallow.

---

## 6. Event store (`src/events/store.ts`) — the core deliverable

Class or module `EventStore` with:

```ts
// Append one event. Fills in id + ts if not provided.
async function append(input: {
  source: EventSource;
  type: string;
  data?: Record<string, unknown>;
}): Promise<ExecEvent>;

// Read all events from one source's log, oldest → newest.
async function read(source: EventSource): Promise<ExecEvent[]>;

// Read the last N events from one source (or all sources merged & sorted by ts if source omitted).
async function tail(n: number, source?: EventSource): Promise<ExecEvent[]>;
```

Implementation rules:
- `append`:
  - Generates `id` (`crypto.randomUUID()`) and `ts` (`new Date().toISOString()`) if not supplied.
  - Validates `type` prefix matches `source` (throw on mismatch, referencing the bad value).
  - Serializes the event to a single line of JSON + `\n` and **appends** (never rewrites the whole file) to `eventLogPath(source)`.
  - Returns the full stored `ExecEvent`.
  - Must call `bootstrap()`-level safety: if the target file/dir doesn't exist, create it first (so append never fails on a fresh machine).
- `read`:
  - Reads the file, splits on newlines, ignores blank lines, `JSON.parse` each.
  - A single corrupt line must NOT crash the whole read: skip it and log a warning to stderr with the line number. (Robustness matters — this is an append log.)
- `tail`:
  - When `source` omitted: read all 4 logs, merge, sort ascending by `ts`, return last `n`.
- Concurrency: appends may come from multiple callers later. For Phase 1, a simple `await Bun.write`-style append is fine, but **each append must write the full line in one write call** (no partial-line interleaving). Document this assumption in a comment.

---

## 7. CLI (`src/index.ts`)

Parse `process.argv`. Support exactly these commands:

| Command | Behavior |
|---|---|
| `init` | Run `bootstrap()`. Print the resolved `.executiveOS` path and "initialized". Idempotent. |
| `emit <source> <type> [json-data]` | Append an event. `<source>` ∈ {git,terminal,editor,system}. `[json-data]` optional JSON string for `data` (default `{}`). Print the stored event as JSON. |
| `tail [n] [source]` | Print last `n` events (default n=10). Optional source filter. One JSON object per line. |
| `--help` / no args | Print usage. |

- Invalid source, invalid type prefix, or malformed json-data → print a clear error to stderr and exit code `1`.
- Success → exit code `0`.
- Keep argument parsing hand-rolled (no CLI framework dep).

Example session that MUST work:
```
$ bun run src/index.ts init
initialized: /abs/path/.executiveOS

$ bun run src/index.ts emit system system.note '{"msg":"hello"}'
{"id":"...","ts":"2026-...Z","source":"system","type":"system.note","data":{"msg":"hello"}}

$ bun run src/index.ts emit git git.commit '{"branch":"main","sha":"abc123"}'
{...}

$ bun run src/index.ts tail 5
{...system.note...}
{...git.commit...}
```

---

## 8. Tests (`src/events/store.test.ts`) — required, must pass with `bun test`

Set `EXECUTIVE_HOME` to a fresh temp dir in `beforeEach` (and clean it up) so tests never touch the real `.executiveOS/`. Cover at minimum:

1. `bootstrap()` creates the full dir tree + 4 jsonl files + config.json; running twice is idempotent and doesn't clobber config.
2. `append()` writes a valid event, fills id+ts, returns it; the file gains exactly one line.
3. `append()` throws when `type` prefix doesn't match `source` (e.g. source `git`, type `system.note`).
4. `read()` returns appended events in order.
5. `read()` skips a corrupt line without throwing (manually write a bad line, then a good one, assert only the good one comes back).
6. `tail(n)` across all sources returns the newest `n` merged and sorted by `ts`.

---

## 9. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun install` succeeds (or no install needed if zero runtime deps).
- [ ] `bun run src/index.ts init` creates the exact directory tree in §1.
- [ ] `bun run typecheck` passes with zero errors (strict mode).
- [ ] `bun test` passes — all tests in §8 green.
- [ ] The example CLI session in §7 works verbatim (init → emit → emit → tail shows both).
- [ ] Running `init` twice does not error or wipe existing events/config.
- [ ] Emitting with a wrong source/type prefix exits non-zero with a clear message.
- [ ] No out-of-scope features present (no watchers, no LLM, no SQLite, no server, no planner).

---

## 10. Deliverable

A branch/commit containing `src/`, `package.json`, `tsconfig.json` (and this doc left in place). Do NOT commit `.executiveOS/` runtime data. When done, hand back for review — Claude will run every item in §9.
