# Scope — Phase 34.2: Atomic-write hardening, UI timeouts, doc corrections (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. Background — why this phase exists

ExecutiveOS is a TypeScript/Bun runtime. It persists JSON artifacts to a runtime directory
(`.executive/`) using the classic **atomic write** pattern: write to a temp file, then `renameSync(tmp, dst)`.

The previous phase (34.1) discovered that on **Windows** `renameSync` onto an *existing* destination
intermittently fails with `EPERM` — Windows refuses to replace a file while any other handle is open on
it, and antivirus / the search indexer opens a freshly-written file for a few milliseconds. 34.1 fixed
exactly **one** call site (`src/events/seq.ts`) by adding a retry helper `renameOverwrite()`.

A review of 34.1 found four problems. This phase fixes all four. **No new features. No LLM. No new
config keys. No behaviour change on the happy path.**

| # | Problem | Job |
|---|---------|-----|
| 1 | `renameOverwrite` lives in `src/events/seq.ts` (wrong home) and **16 other `renameSync` sites have the identical exposure** — including the ones written every 30 s | Job 1 |
| 2 | The 3 tests added in 34.1 **all pass against plain `renameSync`** — the retry loop itself is completely untested | Job 2 |
| 3 | `Bun.serve`'s `idleTimeout` was set to 120 s, which is **exactly equal** to the LLM client timeout, and far too short for the 81 MB model download endpoint | Job 3 |
| 4 | `GOTCHA.md` / `CLAUDE.md` / `HANDOFF.md` document a bug that **never happened**, plus a wrong number | Job 4 |

---

## 1. Ground rules (a violation of any of these is a defect)

- **No behaviour change on the happy path.** When `renameSync` succeeds first try — which is >99.9 % of
  the time — every code path must behave byte-identically to today.
- **Do NOT change the tmp-file naming, the JSON contents, or the write order** at any call site. The only
  edit at a call site is swapping the function that performs the rename.
- **Do NOT touch any business logic** — planner rules, worker/synth/executor/advisor behaviour, state
  derivation, digest content. This phase is plumbing + tests + docs only.
- **Do NOT add config keys** and do NOT change the shape of `config.json`.
- **Strict TypeScript.** `bun run typecheck` (`tsc --noEmit`) must stay green.
- **All tests offline.** No network, no gateway calls, no spawning browsers.

---

## 2. Job 1 — move `renameOverwrite` to a shared module and route every atomic write through it

### 2.1 Create `src/fs-atomic.ts`

New file. It contains the retry helper, **made injectable so the retry loop is actually testable**
(this is the whole point — see Job 2).

```ts
// Atomic-write helpers shared by every module that persists JSON to .executive/.
//
// Windows trap: renameSync() onto an EXISTING destination intermittently fails with
// EPERM/EBUSY/EACCES, because Windows refuses to replace a file while another handle
// is open on it and antivirus / the search indexer opens a file for a few ms right
// after it is written. The lock is measured in milliseconds, so a short synchronous
// backoff clears it. Anything that is NOT one of those three codes is a real error
// (a genuine second writer, a missing temp file, a bad path) and is rethrown at once.

import { renameSync, unlinkSync } from "node:fs";

/** Injection seam — real fs by default, replaced in tests to exercise the retry loop. */
export interface RenameIo {
  rename(from: string, to: string): void;
  unlink(path: string): void;
  sleep(ms: number): void;
}

export const RETRYABLE_RENAME_CODES = ["EPERM", "EBUSY", "EACCES"] as const;

/** Block the current thread for `ms`. Atomics.wait needs a SharedArrayBuffer view. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const defaultIo: RenameIo = { rename: renameSync, unlink: unlinkSync, sleep: sleepSync };

/**
 * rename() onto an existing file, tolerating a transient Windows EPERM/EBUSY/EACCES.
 *
 * Retries with a 5,10,15… ms backoff (7 sleeps = 140 ms total at the default of 8
 * attempts). On a non-retryable error, or once the attempts are exhausted, the temp
 * file is removed (best effort) and the ORIGINAL error is rethrown — so a genuine
 * second writer still surfaces loudly instead of being papered over.
 *
 * NOTE: the backoff blocks the calling thread. In the `ui` daemon that means the HTTP
 * server stops accepting requests for up to 140 ms — acceptable on an exceptional path,
 * and far better than losing the write.
 */
export function renameOverwrite(
  from: string,
  to: string,
  attempts = 8,
  io: RenameIo = defaultIo
): void {
  for (let i = 0; ; i++) {
    try {
      io.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = (RETRYABLE_RENAME_CODES as readonly string[]).includes(code ?? "");
      if (!retryable || i >= attempts - 1) {
        try {
          io.unlink(from);
        } catch {
          // best effort: never mask the original failure with a cleanup error
        }
        throw err;
      }
      io.sleep(5 * (i + 1));
    }
  }
}
```

Copy this file **verbatim**. Do not "improve" it.

### 2.2 Strip it out of `src/events/seq.ts`

- Delete the `renameOverwrite` and `sleepSync` function bodies from `src/events/seq.ts`, and delete the
  now-unused `unlinkSync` / `renameSync` imports there.
- Add `import { renameOverwrite } from "../fs-atomic.js";` and keep the existing call
  `renameOverwrite(tmpPath, path);` inside `nextSeq()` unchanged.
- `seq.ts` must **not** re-export `renameOverwrite`.

### 2.3 Route the other 16 call sites through it

Find them with:

```bash
grep -rn "renameSync" src/ --include=*.ts
```

At the time of writing, the non-test sites are:

| File | Line (approx) | What it writes |
|---|---|---|
| `src/advisor/store.ts` | 28 | `advisor.json` |
| `src/auto/auto.ts` | 210 | `auto-report.json` |
| `src/compact/compact.ts` | 67 | a rewritten JSONL log |
| `src/config.ts` | 446, 502, 553 | `config.json` (3 updaters) |
| `src/executor/executor.ts` | 206 | `exec-report.json` |
| `src/index.ts` | 45 | a JSON artifact |
| `src/infer/infer.ts` | 47 | `inferred.json` |
| `src/planner/planner.ts` | 87 | `plan.json` |
| `src/report/digest.ts` | 361 | `digest.md` |
| `src/state/builder.ts` | 556 | `state.json` / `context.json` |
| `src/synth/synth.ts` | 114, 129 | `changeset.json`, `synth-report.json` |
| `src/worker/orchestrator.ts` | 88, 94 | proposal history + latest |

Line numbers may drift — **trust the grep, not this table.** At each site:

1. Replace `renameSync(a, b);` with `renameOverwrite(a, b);`
2. Remove `renameSync` from that file's `node:fs` import (keep the other named imports).
3. Add `renameOverwrite` to the imports, using the correct relative path + the `.js` extension the
   project uses (e.g. `../fs-atomic.js` from `src/state/`, `./fs-atomic.js` from `src/index.ts`).

**Leave `src/planner/planner.test.ts:9` alone** — that is a test file setting up a fixture, not an
atomic write.

**Do not change anything else in those files.** After the edit,
`git diff --stat` should show 1–3 changed lines per file (import + call), nothing more.

---

## 3. Job 2 — tests that actually exercise the retry loop

### 3.1 The problem you are fixing

`src/events/seq.test.ts` currently has 3 tests. **All 3 pass even if `renameOverwrite` is replaced by a
bare `renameSync`** — so the retry logic, the backoff schedule, and the temp-file cleanup have zero
coverage. This project's convention (documented in `GOTCHA.md` §4) is that a test must **fail** against
the un-fixed code, or it is not a test.

### 3.2 Create `src/fs-atomic.test.ts`

Use `bun:test` (`import { describe, test, expect } from "bun:test";`), matching the style of the existing
test files. Build a fake `RenameIo` and inject it. Suggested helper:

```ts
function fakeIo(script: (Error | null)[]) {
  // script[i] = the error thrown by the i-th rename attempt, or null to succeed
  const calls = { rename: 0, unlink: 0, sleeps: [] as number[] };
  const io = {
    rename(_f: string, _t: string) {
      const e = script[calls.rename] ?? null;
      calls.rename++;
      if (e) throw e;
    },
    unlink(_p: string) { calls.unlink++; },
    sleep(ms: number) { calls.sleeps.push(ms); },
  };
  return { io, calls };
}
function errWithCode(code: string): Error {
  const e = new Error(code + ": simulated") as NodeJS.ErrnoException;
  e.code = code;
  return e;
}
```

Required tests (all must be present):

1. **`succeeds first try — no sleep, no unlink`**
   Script `[null]` → `renameOverwrite("a","b",8,io)` returns; `calls.rename === 1`,
   `calls.sleeps` is `[]`, `calls.unlink === 0`.
2. **`retries a transient EPERM and then succeeds`**
   Script `[EPERM, EPERM, null]` → returns without throwing; `calls.rename === 3`;
   `calls.sleeps` equals `[5, 10]`; `calls.unlink === 0` (the temp was consumed, not deleted).
3. **`retries EBUSY and EACCES too`**
   Script `[EBUSY, EACCES, null]` → returns; `calls.rename === 3`.
4. **`gives up after the attempt budget, rethrows the original error, removes the temp`**
   Script of 8× `EPERM` → `expect(() => …).toThrow()` and the thrown error's `.code` is `"EPERM"`;
   `calls.rename === 8`; `calls.sleeps` equals `[5,10,15,20,25,30,35]` (7 sleeps, **140 ms total**);
   `calls.unlink === 1`.
5. **`does not retry a non-retryable error`**
   Script `[ENOENT]` → throws; `calls.rename === 1`; `calls.sleeps` is `[]`; `calls.unlink === 1`.
6. **`honours a custom attempts count`**
   Script of 3× `EPERM` with `attempts = 3` → throws; `calls.rename === 3`; `calls.sleeps` is `[5, 10]`.
7. **`replaces an existing destination through the real filesystem`** (integration, default io)
   In a `mkdtempSync` temp dir: write `src.txt` = `"new"`, `dst.txt` = `"old"`, call
   `renameOverwrite(src, dst)`, assert `dst` reads `"new"` and `src` no longer exists. Clean up the dir
   in `afterEach`.
8. **`sleepSync blocks for at least the requested time`**
   `const t = Date.now(); sleepSync(20); expect(Date.now() - t).toBeGreaterThanOrEqual(15);`
   (a loose lower bound — do not assert an upper bound, timers are not precise).

### 3.3 Update `src/events/seq.test.ts`

- Delete the `describe("renameOverwrite", …)` block entirely — it now lives in `fs-atomic.test.ts`.
- Keep the `describe("nextSeq", …)` block (monotonic increment + no stray `meta.json.*` temp files) and
  its `beforeEach`/`afterEach` `EXECUTIVE_HOME` setup **exactly as they are**.
- Fix the duplicate import: the file currently imports from `./seq.js` on two separate lines. Merge into
  one `import { nextSeq, currentSeq } from "./seq.js";` and drop the now-unused imports
  (`renameOverwrite`, `readFileSync`, `writeFileSync`, `existsSync` — check what is still used and remove
  only the unused ones; `tsc` will not catch unused imports, so read carefully).

### 3.4 Mandatory sabotage check — report the result

After the tests are green, **temporarily** change `src/fs-atomic.ts` so that `renameOverwrite` does
nothing but `io.rename(from, to)` (no try/catch, no retry). Run `bun test src/fs-atomic.test.ts`.

**Tests 2, 3, 4, 5 and 6 must FAIL.** Then restore the real implementation and confirm everything is
green again.

In your final report, state explicitly: *"sabotage check: tests N, N, N failed against the stripped
implementation, all green after restore."* If fewer than 5 tests fail, your tests are not covering the
logic — fix them, do not report success.

---

## 4. Job 3 — UI server timeouts

### 4.1 `idleTimeout` must exceed the LLM client timeout

`src/ui/server.ts` currently hardcodes `idleTimeout: 120` inside `Bun.serve({ … })`.

`src/config.ts` exports `llmTimeoutMs(config, floor = 120000)`, which every LLM client uses
(`src/advisor/factory.ts`, `src/worker/factory.ts`, `src/synth/factory.ts`, `src/infer/factory.ts`).
Its floor is 120 000 ms = **exactly** the 120 s server timeout, so a gateway call that runs to its own
timeout races the server's — the dashboard can still show a dead request in precisely the slow case the
setting was added for.

Change it so the server always outlives the client. Inside `startUiServer`, before the `Bun.serve` call:

```ts
// The server must outlive the slowest handler. /api/propose awaits the LLM gateway,
// whose client timeout floors at llmTimeoutMs (120s), so an equal server timeout races
// it. Bun caps idleTimeout at 255s.
let idleTimeout = 150;
try {
  idleTimeout = Math.min(255, Math.ceil(llmTimeoutMs(loadConfig()) / 1000) + 30);
} catch {
  // unreadable config at startup must not stop the dashboard from serving
}
```

and pass `idleTimeout,` in the `Bun.serve` options. `loadConfig` and `llmTimeoutMs` are both already
importable from `../config.js` — check whether `loadConfig` is already imported in that file before
adding a duplicate import.

### 4.2 `/api/transcribe/download` must not block the request

`POST /api/transcribe/download` currently `await`s `downloadWasmAssets(modelId)`, which fetches an
**81 MB** model. The dashboard button's own label says *"Downloading… (can take a few min)"* — so this
request routinely exceeds any legal `idleTimeout` (Bun's max is 255 s). Raising the timeout cannot fix
it; the request must return immediately and the page must poll.

A polling endpoint **already exists**: `GET /api/transcribe/status`. Use it.

**In `src/ui/server.ts`,** add module-level state *outside* `startUiServer` (top level of the file):

```ts
// Model download runs in the background: the payload is ~81MB, far longer than any
// legal idleTimeout. POST kicks it off, GET /api/transcribe/status reports progress.
let downloadRunning = false;
let downloadResult: unknown = null;
let downloadError: string | null = null;
```

Rewrite the `POST /api/transcribe/download` handler to:

1. Resolve `modelId` exactly as it does today (body `model` → `cfg.transcribe?.wasmModel` →
   `"Xenova/whisper-base"`).
2. If `downloadRunning` is `true`, return `Response.json({ started: false, running: true })` with status
   `200` — a second click is not an error.
3. Otherwise set `downloadRunning = true; downloadResult = null; downloadError = null;` then start the
   download **without awaiting it**:
   ```ts
   downloadWasmAssets(modelId)
     .then((r) => { downloadResult = r; })
     .catch((e) => { downloadError = (e as Error).message; })
     .finally(() => { downloadRunning = false; });
   ```
4. Return `Response.json({ started: true, running: true }, { status: 202 })`.

Rewrite `GET /api/transcribe/status` to keep its existing fields and **add** a `download` block:

```ts
return Response.json({
  ...wasmAssetsStatus(cfg.transcribe?.wasmModel ?? "Xenova/whisper-base"),
  download: { running: downloadRunning, result: downloadResult, error: downloadError },
});
```

Do not remove or rename any existing field of that response — `src/ui/page.ts` reads `libReady` and
`modelReady` from it.

### 4.3 Make the page poll

In `src/ui/page.ts`, rewrite `downloadModel()` (currently around line 542) so it:

1. POSTs as it does today, and reads the JSON.
2. If `!j.started && !j.running`, toast the error and stop.
3. Otherwise poll `GET /api/transcribe/status` **every 2000 ms** until `s.download.running === false`,
   then:
   - `s.download.error` → `toast("download failed: " + s.download.error)`
   - else if `s.download.result?.ok` → `toast("downloaded " + result.files + " file(s), " +
     Math.round(result.bytes / 1e6) + " MB")`
   - else → `toast("download failed: " + (result?.error || "unknown"))`
4. Keeps the button disabled for the whole poll and re-enables it in a `finally`, restoring the label
   `"Download model for offline use"` and calling `refreshDlStatus()` — exactly as today.
5. Gives up after **300 polls** (10 minutes) with `toast("download still running — check back later")`,
   so a hung download cannot leave the button disabled forever.

`page.ts` is a TypeScript file holding the dashboard HTML/JS as a template string — mind the existing
escaping conventions in that file (e.g. `\\d` inside regexes). Keep the surrounding style.

### 4.4 Tests for Job 3

Add to `src/ui/ui.test.ts` (it already starts a real server on `port: 0` — follow the existing pattern
in that file):

1. **`download returns immediately and reports running`** — `POST /api/transcribe/download` with a body
   of `{ model: "definitely-not-a-real-model/xxx" }` returns within **2 seconds** with
   `started === true`. (The background fetch will fail; that is fine and must not crash the server.)
2. **`status exposes the download block`** — `GET /api/transcribe/status` returns an object that still
   has `libReady` and `modelReady`, and now also has a `download` object with a boolean `running`.

If test 1 is flaky because the fake model id resolves fast, assert only on `started`/`running` and the
elapsed time — do not assert on the eventual result.

---

## 5. Job 4 — correct the documentation

Three docs record a bug that never happened. Verified with
`git log -S'test: "false"' -- src/executor/executor.test.ts` (**no commits**) and
`git show 2ea716a:src/executor/executor.test.ts` (line 428 has been `test: "exit 1"` since Phase 6).

The **real** trap is only: `test: "true"` fails on Windows because `true` is not a command in `cmd.exe`,
so the test that was supposed to assert the PASS path was green/red for the wrong reason.

### 5.1 `GOTCHA.md` §2

In the bullet **"`true` and `false` are not commands in `cmd.exe`"**:
- Delete the claim that the sibling used `test: "false"` and "passes for the wrong reason".
- Keep the cause (`spawnSync` with `shell: true` is `cmd.exe` on Windows) and the fix (`exit 0`/`exit 1`,
  valid in both `cmd` and POSIX `sh`).

In the bullet about **`rename()` … `EPERM` on Windows**:
- Change **"~180ms total"** to **"140 ms total (5,10,15…35 across 7 retries)"**.
- Replace the closing sentence *"The same fragility applies to every other temp+rename in the tree …
  they just haven't been observed losing the race yet"* with: *"Every atomic write in the tree now goes
  through `renameOverwrite` in `src/fs-atomic.ts` (Phase 34.2)."*
- Update the file reference from `src/events/seq.ts` to `src/fs-atomic.ts`.

### 5.2 `CLAUDE.md` — the Phase 34.1 entry

- Change **"~180ms total"** to **"140 ms total"**.
- Delete the sentence fragment claiming the `"false"` sibling *"had been passing for the wrong reason"*;
  say instead that only the passing-path case was wrong (`"true"` → `exit 0`), and that the failing-path
  case has correctly used `exit 1` since Phase 6.

Then **append a new Phase 34.2 entry** at the end of the phase list, in the same voice and format as the
entries around it (a `- **Phase 34.2 — DONE** (…)` bullet). State: `renameOverwrite` moved to
`src/fs-atomic.ts` with an injectable `RenameIo` seam and all 16 remaining `renameSync` sites routed
through it; the retry loop now has real coverage (the 34.1 tests all passed against plain `renameSync`);
`idleTimeout` derived from `llmTimeoutMs` instead of a hardcoded 120 s; the model download made
non-blocking with page-side polling of the existing status endpoint; the three doc corrections. Include
the final test count from `bun test`.

### 5.3 `HANDOFF.md`

- In the `| 34.1 |` table row, delete the parenthetical *"(its `"false"` sentence had been green for the
  wrong reason)"*.
- Add a `| 34.2 | **Atomic-write hardening** | …one-line summary… |` row after it.
- Update the two hardcoded test counts (`519 passing tests` in the header blockquote, and
  `bun test   # 519 tests, offline`) to whatever `bun test` actually reports when you are done.
- **Delete the whole "⏭️ Candidate C — harden the other atomic writes" section** — Job 1 does exactly
  that, so the candidate is spent.

---

## 6. What is NOT in scope (do not build any of this)

- **No new features.** No new CLI command, no new endpoint beyond the `download` field added to an
  existing response, no new config key, no new event type.
- **Do not unify the temp-file naming** or introduce a `writeFileAtomic()` helper. Each call site keeps
  its own tmp path; only the rename call changes.
- **Do not make the retry asynchronous.** `sleepSync` stays synchronous — the callers are synchronous
  and making them async would ripple through the entire codebase.
- **Do not widen `RETRYABLE_RENAME_CODES`.** Exactly `EPERM`, `EBUSY`, `EACCES`. Everything else must
  throw immediately — that is what makes a genuine second-writer bug visible.
- **Do not touch** `src/planner/*` rules, `src/state/builder.ts` derivation logic, `src/advisor/*`
  prompts, `src/screen/*`, `src/worker/*` prompts, or any `*.test.ts` other than the ones named in this
  scope.
- **Do not run** `bun run test:e2e` (needs a browser + an 81 MB model) and do not make any network call.

---

## 7. Acceptance criteria — the reviewer will run every one of these

1. `bun run typecheck` → exits 0, no errors.
2. `bun test` → all green. Report the exact count.
3. `grep -rn "renameSync" src/ --include=*.ts` → matches **only** `src/fs-atomic.ts` (the import + the
   default io) and `src/planner/planner.test.ts`. No other file calls `renameSync` directly.
4. `grep -rn "renameOverwrite" src/ --include=*.ts | wc -l` → at least 18 (the definition + 17 imports/calls).
5. `bun test src/fs-atomic.test.ts` → 8 tests green.
6. **Sabotage:** with `renameOverwrite`'s body reduced to a bare `io.rename(from, to)`, at least 5 of the
   8 tests fail. Report which.
7. `grep -n "idleTimeout" src/ui/server.ts` → no hardcoded `120`; the value derives from `llmTimeoutMs`.
8. `grep -n "await downloadWasmAssets" src/ui/server.ts` → **no matches** (it must be fire-and-forget).
9. `grep -rn 'test: "false"' .` → matches only inside this scope doc, nowhere in `GOTCHA.md`,
   `CLAUDE.md`, or `HANDOFF.md`.
10. `grep -rn "180ms" GOTCHA.md CLAUDE.md src/` → no matches.
11. `git diff --stat` shows **no** changes to `src/planner/rules.ts`, `src/state/builder.ts` (beyond the
    one-line rename swap + import), `src/advisor/*` (same), or any prompt text.

---

## 8. Report back with

- The exact `bun test` count before and after.
- The sabotage-check result (which test numbers failed against the stripped implementation).
- The list of files you changed, with a one-line reason each.
- Anything in this scope that turned out to be wrong about the codebase (wrong line number, an import
  that did not exist, a function signature that differed) — say so explicitly rather than working around
  it silently.
