# Phase 43 — Back up `.executive/config.json` on every write

> **Read this spec only.** Do NOT read `CLAUDE.md`, `HANDOFF.md` or `GOTCHA.md` — everything you need
> is here. Work file by file; `grep` rather than reading whole files.
>
> **NEVER print full test output** — always `bun test 2>&1 | tail -20`. The suite prints 880+ `(pass)`
> lines and a few full runs will exhaust your context before you finish.
>
> Repo root: `C:\Users\yiw20\Programming\myshi\executive`. Runtime: **Bun + TypeScript (strict)**.
> `bun run typecheck` must stay green. Keep the final report under 20 lines.

---

## 1. Why (the evidence)

`.executive/config.json` is the runtime's configuration. It is **gitignored**, hand-edited, and holds
the **only** copy of several settings that cannot be re-derived from anything else:

- `discord.ownerId` — the Discord user allowed to command the agent
- `agent.repoSearchRoots` — the directories the agent may discover repos under
- `agent.fileOutput.dirs` — the folders the agent is allowed to write files into
- `agent.trustedTools`, every autonomy toggle, the screen-OCR engine + language choice

**It has already been destroyed once**, by something that wrote a small test fixture over it. Every
setting above was lost and had to be reconstructed by inference; some blocks were never recovered.

There is a file on disk named `.executive/config.json.pre-sqlite` that looks like a backup. It is
**not** one: it is dated 2026-07-25 and a `diff` against the live config shows it is **missing the
entire `agent` and `advisor` blocks**. Restoring it would silently produce a runtime with no Discord
owner, no repo discovery and no file-output directories — a file that looks like insurance and is not.

Six functions in `src/config.ts` overwrite this file today, each with an identical three-line
temp+rename block, and **none of them preserves the previous contents**:

| line | function |
|------|----------|
| 607 | `updateTranscribeConfig` |
| 685 | `updateAutonomyConfig` |
| 734 | `updateFileOutputConfig` |
| 755 | `addFileOutputDir` |
| 800 | `trustTool` |
| 854 | `updateScreenConfig` |

Several of these are reachable from the **dashboard over HTTP** (`POST /api/settings`,
`/api/autonomy`, …), i.e. from a click, and `trustTool` is reachable from a chat confirmation.

`src/bootstrap.ts:34` also touches the path but writes **only when the file does not exist**, so it can
never destroy anything and is out of scope.

---

## 2. Goal

Before `config.json` is overwritten, preserve what it currently says, with enough history that a bad
write is recoverable and a *series* of bad writes cannot evict the last good copy.

**Non-goal:** preventing bad writes. This is a safety net, not a validator.

---

## 3. Job 1 — one choke point

The six sites are byte-identical:

```ts
const tmp = configPath() + ".tmp";
writeFileSync(tmp, raw);
renameOverwrite(tmp, configPath());
```

Replace all six with a single call to a new **non-exported** helper in `src/config.ts`:

```ts
/**
 * Write config.json atomically, preserving the previous contents first.
 * `raw` is the exact bytes to write (callers already build them).
 */
function writeConfigFile(raw: string): void
```

### 3.1 Behaviour, in order

1. **Back up** — call `backupConfig()` (Job 2). Wrapped so a backup failure can never abort the write.
2. **Write** — the existing `writeFileSync(tmp, raw)` + `renameOverwrite(tmp, configPath())`, unchanged.

The happy path must stay **byte-identical** to today: same bytes, same temp path, same
`renameOverwrite`. Only the backup step is new.

### 3.2 Do not change the callers' behaviour

Each of the six functions keeps its current validation, whitelisting and return value. You are moving
three lines out of each, nothing else. In particular `updateAutonomyConfig` must keep ignoring
`patch.autopilotApply` in both directions — do not touch that logic.

---

## 4. Job 2 — the backup itself

New file: **`src/config-backup.ts`**.

```ts
/** Directory holding config backups. */
export function configBackupDir(): string;          // execRoot() + "/config-backups"

/** Newest-first list of rotating backup file paths currently on disk. */
export function listConfigBackups(): string[];

/**
 * Preserve the current config.json before it is overwritten.
 * Never throws — a backup failure must never block a config write.
 */
export function backupConfig(): void;

/** How many rotating backups to keep. */
export const MAX_CONFIG_BACKUPS = 10;
```

`configBackupDir()` belongs in **`src/paths.ts`** alongside the other path helpers (`configPath`,
`eventsDir`, …), exported from there and re-used by `config-backup.ts`. Follow the existing style in
that file exactly.

### 4.1 `backupConfig()` rules

1. **Nothing to preserve → no-op.** If `config.json` does not exist, return immediately. (This is the
   `init` case.)
2. **Read the current bytes.** An unreadable file → return (no-op). Never throw.
3. **Genesis snapshot.** If `config-backups/config-genesis.json` does **not** exist, write the current
   bytes there. **Written once, never overwritten, never rotated.** This is the copy that survives a
   run of repeated bad writes, and it uses the same "only if absent" idempotent pattern that
   `bootstrap()` already uses for `claude.md`.
4. **Skip an identical backup.** If the newest rotating backup already holds byte-identical content,
   do not write another one. Rationale: the dashboard saves settings on trivial changes, and ten
   identical snapshots would push the interesting history out of the window.
5. **Rotating snapshot.** Otherwise write the current bytes to
   `config-backups/config-<timestamp>.json`, where `<timestamp>` is an ISO-8601 UTC instant with `:`
   and `.` replaced by `-` (filesystem-safe on Windows), e.g. `config-2026-07-27T10-14-52-317Z.json`.
6. **Rotate.** After writing, delete the oldest rotating backups until at most `MAX_CONFIG_BACKUPS`
   remain. **`config-genesis.json` is never counted and never deleted.** A delete failure is ignored.
7. **Never throw, ever.** The whole body is defensive; a caller must be able to call it blindly.

### 4.2 Ordering matters

Sort by the **filename**, not by mtime. The timestamp format above sorts lexicographically in
chronological order, and mtime is unreliable on Windows (the search indexer and AV touch files).

### 4.3 Writes are plain

These are small snapshots written to fresh, unique paths — a plain `writeFileSync` is correct.
Do **not** route them through `renameOverwrite` (that helper exists for overwriting a file another
process may hold open; nothing overwrites a backup).

---

## 5. What is NOT in scope

- **No restore command.** Recovery is "copy the file back by hand" — deliberate: an automated restore
  is one more thing that can overwrite a good config. Do not add a CLI command, an endpoint, or a
  dashboard button.
- **No config validation / schema check.** Not this phase.
- **No change to `bootstrap.ts`.** It only writes when the file is absent.
- **No change to what any of the six functions accept, validate, or return.**
- **Do not touch `.executive/config.json.pre-sqlite`.** Leave the stale file alone; it is the owner's
  to delete.
- **Do not fix the shared temp path.** All six sites use the same fixed `configPath() + ".tmp"`, so two
  concurrent writers could interleave. That is a real latent issue and it is **explicitly out of
  scope** — do not change it, do not add locking. Mention it in your final report if you like.
- **No compression, no encryption, no pruning by age.** Count-based rotation only.

---

## 6. Acceptance criteria

Write these as tests in a new **`src/config-backup.test.ts`**.

> **Every test MUST set `process.env.EXECUTIVE_HOME` to a temp directory in `beforeEach` and delete it
> in `afterEach`.** `execRoot()` throws under `NODE_ENV=test` when `EXECUTIVE_HOME` is unset — that
> guardrail exists because a previous run destroyed the owner's real config. Copy the `setupHome()` /
> `teardownHome()` pattern from `src/proactive/proactive.test.ts`.

1. `backupConfig()` with **no `config.json` on disk** → no-op, creates no directory, does not throw.
2. `backupConfig()` with a config present → `config-backups/config-genesis.json` exists and its
   content is byte-identical to `config.json`.
3. …and exactly one rotating `config-<ts>.json` also exists, byte-identical.
4. **Genesis is never overwritten:** back up, change `config.json`, back up again → `config-genesis.json`
   still holds the **first** content.
5. **Identical content is skipped:** calling `backupConfig()` twice with no change in between produces
   exactly **one** rotating backup.
6. **Rotation:** with `MAX_CONFIG_BACKUPS = 10`, writing 13 *different* configs (calling `backupConfig()`
   before each change) leaves exactly 10 rotating backups, and the ones kept are the **newest 10**
   (assert on the surviving contents, not just the count).
7. **Genesis survives rotation:** in the same scenario, `config-genesis.json` still exists and still
   holds the original content.
8. `listConfigBackups()` returns newest-first and **never includes** `config-genesis.json`.
9. **Never throws:** make the backup directory unwritable *or* stub the write to throw, then call
   `backupConfig()` → it returns normally.
10. **End-to-end, via a real config writer:** set up a home, `bootstrap()`, then call
    `updateAutonomyConfig({ advisorEnabled: true })`. Assert (a) `config.json` has the new value,
    (b) a backup exists holding the value from **before** the call.
11. **Same, for a second writer:** `updateScreenConfig` (or `trustTool`) also produces a backup —
    proving the choke point is shared, not wired into one function.
12. **A backup failure does not block the write:** stub `backupConfig` to throw, call
    `updateAutonomyConfig(...)`, and assert `config.json` still received the new value.
13. **The happy path is unchanged:** the bytes `config.json` receives after `updateTranscribeConfig`
    are exactly what they were before this phase (assert the parsed JSON round-trips the patch and the
    file ends with a trailing newline, as today).

Existing tests in `src/config.test.ts` must keep passing untouched. If one fails, you have changed
caller behaviour — fix your code, not the test.

---

## 7. Sabotage check (required — run it, do not assume)

Break the code, run `bun test 2>&1 | tail -20`, confirm the named criterion goes **red**, then restore.
Report the result for each row.

| # | Sabotage | Must fail |
|---|----------|-----------|
| 1 | Make `backupConfig()` overwrite `config-genesis.json` every call | 4, 7 |
| 2 | Remove the identical-content skip | 5 |
| 3 | Let rotation count/delete `config-genesis.json` | 7 |
| 4 | Rotate to keep the **oldest** 10 instead of the newest | 6 |
| 5 | Call `backupConfig()` **after** the rename instead of before | 10, 11 |
| 6 | Wire the backup into `updateAutonomyConfig` only, not the shared helper | 11 |

Sabotage 5 is the important one: a backup taken after the write preserves the **new** contents and is
worthless. If criterion 10 stays green under it, criterion 10 is not really testing what it claims.

---

## 8. Files

- **New:** `src/config-backup.ts`, `src/config-backup.test.ts`
- **Edit:** `src/paths.ts` (add `configBackupDir()`), `src/config.ts` (add `writeConfigFile`, route the
  six writers through it)
- **Do not touch anything else.** `git status` at the end must show exactly these four files.

---

## 9. Report

Under 20 lines: what you implemented, the criteria you ran and their result, the sabotage table with
the observed failures, and `bun test 2>&1 | tail -3` plus `bun run typecheck` output. State plainly if
any criterion is unimplemented or failing — a partial, honestly-reported job is worth more than a
claim of completeness.
