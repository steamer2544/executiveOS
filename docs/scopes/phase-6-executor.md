# Scope — Phase 6: Executor (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

ExecutiveOS is an event-driven personal-assistant runtime. Prior phases: event store (1), event bus +
watchers (2), rule-based State Builder (3), rule-based Planner (4), LLM Worker that PROPOSES steps (5).

**Phase 6 is the first phase that MUTATES the repository.** It adds an **Executor**: a
**100% deterministic, rule-based** component (NO LLM) that takes a structured **`ChangeSet`** (a list
of file operations + an optional test command + a commit message) and applies it **safely, reversibly,
and only behind explicit human approval**, on an **isolated git branch** — never on the branch the
owner is working on.

**Core principle (do not violate):** the LLM is a reasoning engine (CPU) only. Phase 6 contains **no
LLM**. It is a pure, testable machine that carries out an already-decided, already-approved change. The
bridge that turns a Phase 5 `Proposal` (prose) into a `ChangeSet` (executable) is a **later phase
(Phase 7)** — do NOT build it here.

### CRITICAL — hard guardrails (a violation of any of these is a defect)

- **Never touch the owner's working branch history.** All mutation happens on a fresh, dedicated
  branch `executive/change-<id>` created from current HEAD. The Executor returns to the original branch
  when done and NEVER commits to it, NEVER merges, NEVER rebases, NEVER force-anything.
- **Refuse on a dirty working tree.** If `git status` shows uncommitted changes, refuse and do nothing
  (protects the owner's in-progress work; keeps the operation clean and reversible).
- **Refuse outside a git repo.**
- **Path safety.** Every op path must be repo-relative and stay strictly inside the repo root. Reject
  absolute paths, drive letters, any `..` that escapes the root, and any path under `.git/` or
  `.executive/`. This is validated BEFORE any mutation.
- **Dry-run is the default.** Without `--apply`, the Executor validates and prints a plan and mutates
  **nothing** (no git, no disk writes). `--apply` is the explicit human approval that authorizes
  mutation.
- **Reversible by construction.** Because all work lands on `executive/change-<id>`, discarding a change
  is `git branch -D executive/change-<id>`. The owner is always the final gate on what merges into their
  real branch — the Executor never merges.

### Out of scope (do NOT build)

- **No LLM, no `Proposal`→`ChangeSet` conversion** (that is Phase 7). The Executor consumes a
  `ChangeSet` JSON that already exists (hand-authored for now).
- No merging into the working branch, no auto-PR, no push, no remote interaction.
- No SQLite, no server, no new watchers. Storage stays JSONL/JSON.
- No unified-diff/patch application, no shell-command execution as ops (file ops only). The single
  shell command allowed is the ChangeSet's optional `test` command, run only under `--apply`.

---

## 1. Data flow

```
(a hand-authored, or later LLM-produced) changeset.json
        │
        ▼
  execute <changeset.json>            → DRY RUN (default): validate + plan, mutate nothing
  execute <changeset.json> --apply    → APPLY: on branch executive/change-<id> …
        │                                  1. verify git repo + clean tree
        │                                  2. checkout -b executive/change-<id>
        │                                  3. apply file ops (write/create/delete)
        │                                  4. git add -A
        │                                  5. run ChangeSet.test (if any), capture pass/fail
        │                                  6. commit (message = ChangeSet.commitMessage)
        │                                  7. checkout <original branch>
        ▼
  .executive/exec-report.json  (latest report)   +   printed summary
```

The Executor is invoked ONLY via the new `execute` CLI command. It is **not** wired into the `watch`
daemon in this phase (autonomous execution comes later, and must not happen without a human).

---

## 2. Tech + constraints (unchanged from prior phases)

- **Runtime:** Bun (latest). Language: TypeScript (strict). No new runtime deps. Use `node:fs`,
  `node:path`, `node:crypto`, and `Bun.spawnSync`/`node:child_process`'s `spawnSync` for git + the test
  command (synchronous is fine and simpler here).
- Storage: JSONL/JSON under `.executive/` only.
- Runs on **Windows 11** — this matters for git invocation. Call git as `git` via `spawnSync` with an
  args array (never string-interpolate paths into a shell). Do not rely on a POSIX shell.
- Tests run offline and deterministically. Git-touching tests create a **temp git repo** in a temp dir
  (offline — `git init`, local commits only; no network, no remote). A test that hits the network is a
  defect.
- The owner cannot read Chinese — user-facing strings in Thai or English only (English for code/logs).

---

## 3. Files to create / edit

### Create — `src/executor/`
```
src/executor/
├── types.ts         # FileOp, ChangeSet, ValidationResult, PlannedOp, ExecReport
├── validate.ts      # validateChangeSet(cs, repoRoot) — pure, incl. path safety
├── plan.ts          # planChangeSet(cs, repoRoot) — dry-run plan (reads disk, NO mutation)
├── git.ts           # thin git helpers via spawnSync (isRepo, isClean, currentBranch, …)
├── executor.ts      # applyChangeSet(cs, opts) — the isolated-branch apply (mutates) + writeReport
└── executor.test.ts # offline tests (pure + temp-git-repo)
```

### Edit
- `src/paths.ts` — add `execReportPath()`.
- `src/config.ts` — add the optional `executor` config block + backward-compatible merge.
- `src/index.ts` — add the `execute` CLI command; update `--help`.

Do NOT edit any other file. In particular do NOT touch `src/worker/*`, `src/planner/*`, `src/state/*`,
`src/events/*`, `src/watchers/*`, `src/bus.ts`, `src/sink.ts`, `src/bootstrap.ts`. Do NOT wire the
Executor into the `watch` daemon.

---

## 4. Types (`src/executor/types.ts`)

```ts
/** A single file operation. Paths are repo-relative. */
export type FileOp =
  | { op: "write"; path: string; content: string }   // create OR overwrite (upsert)
  | { op: "create"; path: string; content: string }  // create ONLY — fails if the file exists
  | { op: "delete"; path: string };                   // delete — fails if the file is missing

/** The unit the Executor applies. Usually hand-authored (Phase 7 will generate it from a Proposal). */
export interface ChangeSet {
  id: string;                    // stable identifier; used in the branch name executive/change-<id>
  title: string;                 // short human description
  ops: FileOp[];                 // ordered file operations (applied top to bottom)
  test: string | null;           // optional shell command run after apply (e.g. "bun test"); null = none
  commitMessage: string;         // commit message used on the isolated branch
  basedOnProposal?: string | null; // optional provenance: a Phase 5 proposal id
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];              // human-readable; empty when ok
}

/** One line of the dry-run plan. */
export interface PlannedOp {
  op: FileOp["op"];
  path: string;
  effect: string;                // e.g. "create new file", "overwrite (1024 → 2048 bytes)", "delete"
  wouldSucceed: boolean;         // false when the op would fail (e.g. create over an existing file)
  note?: string;                 // reason when wouldSucceed is false
}

export interface ExecReport {
  changeSetId: string;
  title: string;
  mode: "dry-run" | "apply";
  ok: boolean;                   // overall success (validation + plan + apply/test as applicable)
  validation: ValidationResult;
  plannedOps: PlannedOp[];
  // apply-mode fields (null in dry-run):
  branch: string | null;         // executive/change-<id>
  originalBranch: string | null;
  committed: boolean;            // whether a commit was made on the branch
  commitSha: string | null;
  testCommand: string | null;
  testPassed: boolean | null;    // null when no test command
  testOutput: string | null;     // stdout+stderr, truncated to ~4000 chars
  messages: string[];            // human-readable log of what happened / why it stopped
  generatedAt: string;           // ISO
}
```

---

## 5. Paths (`src/paths.ts` — addition only)

```ts
/** Absolute path to .executive/exec-report.json (the latest Executor report). */
export function execReportPath(): string {
  return execRoot() + "/exec-report.json";
}
```

---

## 6. Config (`src/config.ts` — additions only)

Add to the `Config` interface:

```ts
  /** Executor configuration (defaults applied when absent). */
  executor?: {
    branchPrefix?: string;          // prefix for the isolated branch; default "executive/change-"
    defaultTestCommand?: string | null; // used when a ChangeSet has test === null; default null
  };
```

In `defaultConfig()` add:

```ts
    executor: {
      branchPrefix: "executive/change-",
      defaultTestCommand: null,
    },
```

In `loadConfig()`, after the `worker` merge, add a backward-compatible `executor` merge (same style):

```ts
  if (!parsed.executor) {
    parsed.executor = defaults.executor!;
  }
  parsed.executor.branchPrefix = parsed.executor.branchPrefix ?? defaults.executor!.branchPrefix!;
  parsed.executor.defaultTestCommand =
    parsed.executor.defaultTestCommand ?? defaults.executor!.defaultTestCommand!;
```

> `defaultTestCommand` default is `null` (no test unless the ChangeSet asks for one, so the Executor
> never runs a command the owner didn't put there). It exists so the owner can opt into a standing test
> gate later. `branchPrefix` lets the owner rename the isolated-branch namespace.

---

## 7. Validation (`src/executor/validate.ts`) — pure, the safety core

```ts
export function validateChangeSet(cs: ChangeSet, repoRoot: string): ValidationResult;
```

Pure function (no I/O). Collect ALL errors (don't stop at the first). Check:

- `cs.id` — non-empty string, and a **safe branch/file token**: matches `/^[A-Za-z0-9._-]+$/` (it goes
  into a git branch name and is echoed to disk). Reject otherwise.
- `cs.title` — non-empty string.
- `cs.commitMessage` — non-empty string.
- `cs.ops` — a non-empty array.
- Each op:
  - `op.op` ∈ {`write`, `create`, `delete`}.
  - `op.path` — non-empty string; `write`/`create` must also have a string `content`.
  - **Path safety** (the important part). Compute `norm = path.normalize(op.path)` with `/` separators.
    Reject if ANY of:
    - `path.isAbsolute(op.path)` is true, or the path has a Windows drive letter (`/^[A-Za-z]:/`).
    - `norm` starts with `..` or contains a `../` segment that escapes root (simplest robust check:
      resolve `path.resolve(repoRoot, op.path)` and require it to be inside `repoRoot` — i.e.
      `resolved === repoRoot` is NOT allowed either; it must be `resolved.startsWith(repoRoot + sep)`).
    - the first path segment is `.git` or `.executive` (case-insensitive) — these are never writable.
  - Error messages must name the offending path and the reason.

Return `{ ok: errors.length === 0, errors }`.

> This function is the guardrail. It is called first in BOTH dry-run and apply, and apply MUST abort if
> `ok` is false, before any git or disk operation.

---

## 8. Dry-run plan (`src/executor/plan.ts`) — reads disk, NO mutation

```ts
export function planChangeSet(cs: ChangeSet, repoRoot: string): PlannedOp[];
```

For each op, statting the current file on disk (read-only, via `existsSync` + `statSync`), produce a
`PlannedOp`:
- `write`: if the file exists → `effect: "overwrite (<old> → <new> bytes)"`, else `"create new file
  (<new> bytes)"`; `wouldSucceed: true`.
- `create`: if the file exists → `wouldSucceed: false`, `note: "file already exists"`,
  `effect: "create (blocked)"`; else `effect: "create new file (<new> bytes)"`, `wouldSucceed: true`.
- `delete`: if the file is missing → `wouldSucceed: false`, `note: "file does not exist"`,
  `effect: "delete (blocked)"`; else `effect: "delete"`, `wouldSucceed: true`.

`<new> bytes` = `Buffer.byteLength(op.content, "utf8")`. No writes, no git. Pure w.r.t. the filesystem
(reads only).

---

## 9. Git helpers (`src/executor/git.ts`) — thin `spawnSync` wrappers

Use `spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" })`. Never pass a shell string. Export:

```ts
export function isGitRepo(repoRoot: string): boolean;      // `git rev-parse --is-inside-work-tree`
export function isWorkingTreeClean(repoRoot: string): boolean; // `git status --porcelain` empty
export function currentBranch(repoRoot: string): string;   // `git rev-parse --abbrev-ref HEAD`
export function branchExists(repoRoot: string, name: string): boolean; // `git rev-parse --verify`
export function checkoutNewBranch(repoRoot: string, name: string): void; // `git checkout -b <name>`
export function checkoutBranch(repoRoot: string, name: string): void;    // `git checkout <name>`
export function stageAll(repoRoot: string): void;          // `git add -A`
export function commit(repoRoot: string, message: string): string;       // `git commit -m <msg>`; return new sha (`git rev-parse HEAD`)
```

Each helper throws a clear `Error` (including git's stderr) on non-zero exit, EXCEPT the boolean probes
(`isGitRepo`, `isWorkingTreeClean`, `branchExists`) which return `false` instead of throwing. Pass the
commit message via the args array (`["commit", "-m", message]`) — no shell, so no quoting/here-string
issues on Windows.

---

## 10. Executor (`src/executor/executor.ts`) — the apply path

```ts
export interface ApplyOptions {
  apply: boolean;       // false = dry-run (default); true = mutate
  repoRoot: string;     // repository root (usually process.cwd())
  config: Config;       // for branchPrefix + defaultTestCommand
}

export function applyChangeSet(cs: ChangeSet, opts: ApplyOptions): ExecReport;
export function writeReport(r: ExecReport): void; // atomic temp+rename to execReportPath()
```

`applyChangeSet` behavior — **in this exact order**:

1. `validation = validateChangeSet(cs, opts.repoRoot)`. Compute `plannedOps = planChangeSet(cs,
   repoRoot)` (safe — read-only). Build a base `ExecReport` (`mode` from `opts.apply`, apply-fields
   null, `generatedAt` = now).
2. **If `!validation.ok`** → set `ok: false`, push a message `"validation failed — no changes made"`,
   return (no mutation).
3. **If NOT `opts.apply` (dry-run)** → set `ok:` = every `plannedOp.wouldSucceed`, push a message like
   `"DRY RUN — pass --apply to execute. <n> ops planned."`, return. **No git, no disk writes.**
4. **Apply mode** (`opts.apply === true`):
   a. `if (!isGitRepo(repoRoot))` → `ok:false`, message `"not a git repository"`, return.
   b. `if (!isWorkingTreeClean(repoRoot))` → `ok:false`, message `"working tree is dirty — commit or
      stash first"`, return.
   c. If any `plannedOp.wouldSucceed === false` → `ok:false`, message naming the blocked op, return
      (do NOT half-apply).
   d. `originalBranch = currentBranch(repoRoot)`. `branch = config.executor.branchPrefix + cs.id`.
      `if (branchExists(repoRoot, branch))` → `ok:false`, message `"branch <branch> already exists —
      delete it first"`, return.
   e. `checkoutNewBranch(repoRoot, branch)`. From here, wrap the rest in try/catch: on ANY thrown
      error, attempt `checkoutBranch(repoRoot, originalBranch)` to restore, record the error in
      `messages`, set `ok:false`, and return the report (best-effort recovery; never leave the caller
      stranded on the change branch silently — always try to return to `originalBranch`).
   f. **Apply file ops** to disk, in order:
      - `write`: `mkdirSync(dirname, { recursive: true })`, `writeFileSync(path, content)`.
      - `create`: same as write (existence already guaranteed by the plan gate in step c).
      - `delete`: `rmSync(path)`.
      Paths resolved via `path.resolve(repoRoot, op.path)`.
   g. `stageAll(repoRoot)`.
   h. **Test:** `cmd = cs.test ?? config.executor.defaultTestCommand`. If `cmd` is a non-empty string,
      run it via `spawnSync` (see below), capture combined stdout+stderr (truncate to ~4000 chars) and
      `testPassed = (exit === 0)`. If `cmd` is null → `testPassed = null`, no run.
   i. **Commit** on the branch: `commitSha = commit(repoRoot, cs.commitMessage)`, `committed = true`.
      Commit **regardless of test pass/fail** — the branch is isolated and inspectable, and committing
      lets us cleanly switch back. The report's `testPassed` flags failure loudly; the human decides
      whether to merge or `git branch -D`. (Rationale: leaving the change committed on a clearly-named
      throwaway branch is both inspectable and reversible.)
   j. `checkoutBranch(repoRoot, originalBranch)` — return to where the owner was.
   k. `ok = (testPassed !== false)` (i.e. ok when tests passed or there was no test). Push messages:
      the branch name, commit sha, test result, and how to inspect/discard:
      `"inspect: git diff " + originalBranch + ".." + branch`,
      `"discard: git branch -D " + branch`.
5. Return the `ExecReport`.

### Running the test command (step h)

```ts
const res = spawnSync(cmd, { cwd: repoRoot, shell: true, encoding: "utf8" });
```
`shell: true` is required so a command like `"bun test"` runs. This is the ONE place a shell command
executes, it runs ONLY in apply mode, and ONLY the command the owner put in the (approved) ChangeSet or
`config.executor.defaultTestCommand`. Truncate `((res.stdout ?? "") + (res.stderr ?? "")).slice(0,
4000)`. Treat a spawn failure (`res.error`) as `testPassed = false` with the error in `testOutput`.

### `writeReport`

Atomic temp+rename to `execReportPath()`, `JSON.stringify(r, null, 2) + "\n"` (same pattern as
`writeProposal`/`writePlan`).

---

## 11. CLI (`src/index.ts`)

### New `execute` command

```
bun run src/index.ts execute <changeset.json>            # DRY RUN: validate + plan, no mutation
bun run src/index.ts execute <changeset.json> --apply    # APPLY on an isolated branch
```

Steps:
1. `await bootstrap();`
2. Require a `<changeset.json>` path arg → else stderr error + exit 1.
3. Read + `JSON.parse` the file → on read/parse error, stderr `"Error: <msg>"` + exit 1.
4. `const config = loadConfig();`
5. `const apply = args.includes("--apply");`
6. `const report = applyChangeSet(cs, { apply, repoRoot: process.cwd(), config });`
7. `writeReport(report);`
8. Print a concise human summary: mode, ok, each planned op line, and (apply) branch + test result +
   the inspect/discard hints. Also print `execReportPath()`.
9. Exit `0` when `report.ok`, else exit `1`. (A blocked/failed change is a non-zero exit so scripts can
   detect it — but note the process never throws uncaught; everything is captured in the report.)

Add to `printUsage()`:
```
  execute <changeset.json> [--apply]            Apply a ChangeSet on an isolated branch (dry-run without --apply)
```

---

## 12. Tests (`src/executor/executor.test.ts`) — required, `bun test`, OFFLINE

Pure tests (no git) + temp-git-repo tests. For git tests, create a temp dir, `git init`, set
`user.email`/`user.name` locally, create + commit an initial file so there is a HEAD and a clean tree.
Clean up the temp dir afterward. Cover at minimum:

**Validation (pure):**
1. A well-formed ChangeSet → `ok: true`, no errors.
2. Path escape `../outside.txt` → `ok: false`, error names the path.
3. Absolute path (`/etc/x` and `C:/x`) → `ok: false`.
4. Path under `.git/` and under `.executive/` → `ok: false` for both.
5. Empty `ops`, empty `id`, bad `id` (`"a b/c"`), missing `content` on a write → each `ok: false`.

**Plan (disk read, no mutation):**
6. `create` over an existing file → `wouldSucceed: false`, note "already exists"; `delete` of a missing
   file → `wouldSucceed: false`. `write` over existing → `wouldSucceed: true`, effect mentions
   "overwrite". Assert the filesystem is unchanged afterward.

**Dry-run (no mutation):**
7. `applyChangeSet(cs, { apply: false, ... })` on a temp git repo → report `mode: "dry-run"`, `branch:
   null`, and **git status is still clean + no `executive/change-*` branch exists + target files
   unchanged**.

**Apply (temp git repo):**
8. Valid ChangeSet (one `write` of a new file, `test: null`) with `apply: true` → report `ok: true`,
   `branch: "executive/change-<id>"`, `committed: true`, `commitSha` set; the branch contains the new
   file; **after the call HEAD is back on the original branch**; the original branch's working tree is
   clean and does NOT contain the new file.
9. Reversibility: after test 8, `git branch -D executive/change-<id>` succeeds and the repo is pristine
   (assert via `git branch --list`).
10. Dirty working tree → `apply: true` returns `ok: false`, message mentions "dirty", and **no branch is
    created**.
11. `test` command that fails (e.g. `test: "exit 1"` or `"false"`) → report `testPassed: false`,
    `ok: false`, but `committed: true` and HEAD is back on the original branch (the failing change is
    parked on its branch, not lost).
12. Not a git repo (temp dir without `git init`) → `apply: true` returns `ok: false`, message "not a git
    repository", no mutation.

**No test may perform a network request.** All 70 existing tests must still pass.

---

## 13. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes (strict).
- [ ] `bun test` passes — existing 70 + new Executor tests, offline.
- [ ] In a throwaway git repo: `execute cs.json` (dry-run) validates + prints a plan, and mutates
      NOTHING (git status clean, no `executive/change-*` branch, target files untouched).
- [ ] `execute cs.json --apply` creates `executive/change-<id>`, applies the ops, runs the test,
      commits on that branch, and returns HEAD to the original branch; the original branch is untouched.
- [ ] After an apply, `git branch -D executive/change-<id>` fully reverses it (repo pristine).
- [ ] Dirty working tree → `--apply` refuses with a clear message and creates no branch.
- [ ] Outside a git repo → refuses with a clear message.
- [ ] A ChangeSet with a `../` escape / absolute path / `.git` or `.executive` target is rejected by
      validation BEFORE any mutation (dry-run and apply both).
- [ ] A failing `test` command → `testPassed:false`, `ok:false`, change parked on its branch,
      HEAD back on original.
- [ ] `.executive/exec-report.json` is gitignored (whole `.executive/` tree already is).
- [ ] No LLM, no network anywhere in `src/executor/`. The only shell exec is the ChangeSet test command
      under `--apply`. (Grep `src/executor/` for `fetch`, `http`, `anthropic`, `openai`.)
- [ ] The Executor is NOT wired into the `watch` daemon.
- [ ] Only the files listed in §3 were created/edited.

---

## 14. Deliverable

A commit containing `src/executor/` and the three edits (`paths.ts`, `config.ts`, `index.ts`), plus this
doc. Do NOT commit `.executive/` runtime data. When done, hand back for review — Claude will run every
item in §13 and will NOT trust the self-report.
