# Scope — Phase 26: Multi-repo watching — actually watch N repos (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

**IMPORTANT — most of the "multi-repo" plumbing already exists.** The State Builder, the Digest, the
dashboard UI, and BOTH watchers were already built to be multi-repo-ready in earlier work. Concretely,
**these are DONE — do NOT re-implement them, only verify they still pass:**

- `State` already has `activeRepo: string | null` and `repos: Array<{name,branch,lastCommit,lastActivityTs}>`
  (`src/state/types.ts`), and `src/state/builder.ts` already groups repo-tagged events per repo, computes
  `activeRepo` (highest-`seq` repo-tagged event), builds the `repos` summary, and derives the top-level
  `git.branch`/`git.lastCommit`/`currentProject`/`currentTask` **from the active repo**.
- `GitWatcher` already tags every `git.commit`/`git.branch_switch` with `data.repo` (folder basename).
- `FsWatcher` already accepts an optional `repo` in its config and tags `editor.save` with `data.repo`
  when set (`src/watchers/fs.ts`).
- The Digest (`src/report/digest.ts`) already renders a `Repos: a* (branch), b (branch)` line, and the UI
  (`src/ui/page.ts`) already renders the repo list with `*` marking the active repo.

**What is MISSING — and all this phase actually delivers — is the ability to watch MORE THAN ONE repo at
once.** Today the `watch`/`ui` daemon builds exactly one `GitWatcher` and one `FsWatcher` from the single
`config.watch.git`/`config.watch.fs`, so only one repo is ever observed — which is why the owner sees
Project = the one watched repo even when working elsewhere. Phase 26 adds a **`config.watch.repos` array**
and builds **one GitWatcher (+ optional FsWatcher) per listed repo**, wiring each FsWatcher's `repo` tag so
the already-working State/Digest/UI light up with multiple repos.

**Core principle (do not violate):** deterministic core, **NO LLM**. You are adding config + constructing
existing watchers in a loop. You are NOT writing new derivation logic (it exists).

### CRITICAL — hard guardrails (a violation of any is a defect)

- **Backward compatible.** A config with no `watch.repos` (every existing config) must behave **exactly as
  today**: one GitWatcher + one FsWatcher from `watch.git`/`watch.fs`, identical events, identical state.
- **No double-watching.** When `watch.repos` is present and non-empty, build watchers **from the array
  only** — do NOT also build the legacy single `watch.git`/`watch.fs` watchers (that would emit duplicate
  events). When `watch.repos` is absent/empty, use the legacy single-repo path, unchanged.
- **Do NOT edit the State Builder, Digest, UI page, GitWatcher, or FsWatcher.** They already do the right
  thing. If you think one needs changing, STOP — the scope is wrong, flag it. (The one exception: you may
  add `repo` when constructing each FsWatcher, which is just passing the existing config field.)
- **No LLM, no network, no new deps.**
- **Unique repo names.** Repo `name` is used as `currentProject` and as the per-repo map key in the State
  Builder, so names must be unique. Enforce it (see §1).

### Out of scope (do NOT build)

- No new derivation, no changes to how `activeRepo`/`repos`/git fields are computed (done).
- No Trello/LINE/YouTube/screen sensing (other phases).
- No auto-discovery of repos on disk — repos are listed explicitly in config.
- No SQLite, no new CLI command, no Planner/Worker/Executor/Synth/Autopilot/Advisor change.

---

## 1. Config (`src/config.ts` — additive, backward-compatible)

Add an optional `repos` array under `watch`:

```ts
  watch?: {
    git: { enabled?: boolean; repoPath?: string; pollMs?: number };
    fs:  { enabled?: boolean; paths?: string[]; debounceMs?: number };
    /** Multi-repo mode. When present and non-empty, these REPLACE the single git/fs watchers above. */
    repos?: Array<{
      path: string;            // repo root (required)
      name?: string;           // display/repo name; default = basename(path)
      pollMs?: number;         // git poll cadence; default 5000
      watchFiles?: boolean;    // also run an FsWatcher on this repo; default true
      filePaths?: string[];    // fs watch roots; default [path + "/src"]
      fileDebounceMs?: number; // default 300
    }>;
  };
```

- `defaultConfig()` does **not** add a `repos` key (default stays single-repo — backward compatible).
- In `loadConfig()`, only when `parsed.watch?.repos` is present and non-empty, **normalize** each entry:
  - `name` ← `name` or `basename(path)` (strip trailing `/\` then take the last `/`-or-`\` segment — the
    same logic `GitWatcher`'s `repoName` uses; feel free to copy that tiny helper or export it).
  - fill `pollMs ?? 5000`, `watchFiles ?? true`, `filePaths ?? [path + "/src"]`, `fileDebounceMs ?? 300`.
  - **Name collisions:** if two normalized names are equal, keep both but make later ones unique by
    appending ` (2)`, ` (3)`, … in array order, and write one stderr warning. (Unique names are required —
    see guardrails.)
- If `watch.repos` is absent/empty, leave it `undefined` — the legacy path runs.

**Backward compatibility (must verify):** a config with no `watch.repos` loads and produces the exact same
`watch.git`/`watch.fs` defaults as today.

---

## 2. `buildWatchers` — construct the watcher list once, shared by `watch` + `ui` (`src/watchers/build.ts` — new)

Two `case` blocks in `src/index.ts` (`watch` and `ui`) currently duplicate the "build git + fs watcher
from config" logic. Extract a single shared function so both use identical logic and multi-repo lands in
one place:

```ts
import type { Config } from "../config.js";
import type { Watcher } from "./index.js";
export function buildWatchers(config: Config): { watchers: Watcher[]; activeNames: string[] };
```

Logic:

```
const watchers = []; const activeNames = [];
if (config.watch?.repos && config.watch.repos.length > 0):
    for each normalized repo entry:
        watchers.push(createGitWatcher({ repoPath: entry.path, pollMs: entry.pollMs }))
        activeNames.push("git:" + entry.name)
        if entry.watchFiles !== false:
            watchers.push(createFsWatcher({ paths: entry.filePaths, debounceMs: entry.fileDebounceMs,
                                            repo: entry.name }))   // <-- the repo tag makes State light up
            activeNames.push("fs:" + entry.name)
else:  // legacy single-repo path — byte-for-byte what index.ts does today
    const git = config.watch?.git ?? {}; const fs = config.watch?.fs ?? {};
    if (git.enabled !== false):
        watchers.push(createGitWatcher({ repoPath: git.repoPath ?? process.cwd(), pollMs: git.pollMs ?? 5000 }))
        activeNames.push("git")
    if (fs.enabled !== false):
        watchers.push(createFsWatcher({ paths: fs.paths ?? [process.cwd()+"/src"], debounceMs: fs.debounceMs ?? 300 }))
        activeNames.push("fs")
return { watchers, activeNames };
```

- Multiple `createGitWatcher` instances are already safe together (each keeps its own closure state — see
  the comment at the top of `src/watchers/git.ts`). Do not add cross-instance coordination.
- Pass `repo: entry.name` to each per-repo `createFsWatcher` — this is the whole point: it makes
  `editor.save` events carry `data.repo`, which the State Builder already consumes.

---

## 3. Wire `buildWatchers` into `src/index.ts` (`watch` + `ui` cases)

- In the `watch` case, replace the inline git/fs construction with
  `const { watchers, activeNames } = buildWatchers(config);` then the existing `new WatcherManager(bus,
  watchers)` / `startAll()` / banner. Keep everything else (StoreSink, rebuild timer, autopilot/infer/
  advisor wiring, SIGINT) untouched.
- In the `ui` case, do the same, but keep honoring `--no-watch` (when set, start no watchers — call
  `buildWatchers` only when watchers are wanted, or ignore its result).
- Banner: print the active repos, e.g. `Watching repos: opm, executive` when multi-repo, or the existing
  `Active watchers: git, fs` line when single. Keep it one line.

Do NOT change the EventBus, StoreSink, timers, or signal handling.

---

## 4. Tests (`bun test`, OFFLINE) — required

`src/watchers/build.test.ts` (new) — assert the **shape of the returned watcher list**, not live polling
(do not start real watchers / spawn git):

1. **Legacy path:** a config with no `watch.repos` → `buildWatchers` returns one git + one fs watcher
   (names `["git","fs"]`); with `watch.git.enabled:false` → fs only; with both disabled → `[]`.
2. **Multi-repo path:** a config with `watch.repos` of 2 entries (second `watchFiles:false`) → returns
   `git:A, fs:A, git:B` (3 watchers), names reflect the repos; the legacy single watchers are **not**
   present.
3. **fs repo tag:** the per-repo FsWatcher is constructed with `repo` = the entry name. (Assert via a spy
   / by having `createFsWatcher` record its config, or check the watcher's `name`/exposed config — pick the
   least invasive way; if the watcher does not expose its config, wrap `createFsWatcher` behind an
   injectable in the test, or assert indirectly by running the watcher against a temp save and checking the
   emitted `data.repo`.)

`src/config.test.ts` (or `build.test.ts`):

4. **Normalization:** a `watch.repos` entry with only `path` → `name` = basename, `pollMs`/`watchFiles`/
   `filePaths`/`fileDebounceMs` defaults filled.
5. **Name collision:** two entries whose paths basename to the same name → effective names `x`, `x (2)`.
6. **No `repos` key → `undefined`** and the legacy git/fs defaults are unchanged.

Optionally, one integration-flavored test using the **existing** builder: feed an event log containing
`git.commit{repo:"B"}` newer than `git.commit{repo:"A"}` and assert `buildState().activeRepo === "B"` —
but note this only **re-confirms existing behavior**; the builder is already tested, so keep this light.

All existing tests (260) must still pass. **No test may start a real long-running watcher, spawn git, or
hit the network.**

---

## 5. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes (strict); `bun test` passes offline (260 + new).
- [ ] **Backward compat:** an old single-repo config (no `watch.repos`) → `watch` starts exactly one git +
      one fs watcher and `state.json` is unchanged. Verified live in a temp git repo.
- [ ] **Two real repos (the core deliverable):** create two temp git repos, list both in `watch.repos`,
      run `watch`; commit in repo B → `report` shows Project = B, Branch = B's branch, and the `Repos:`
      line lists both with B active. Then commit in repo A → active flips to A, Branch follows. **This is
      the fix: Project/Branch/Task stay coherent across repos, and both repos are actually observed.**
- [ ] **fs repo tag:** saving a file in repo B (while watched via `watch.repos`) produces
      `editor.save{repo:"B"}` (grep the event log), and with B newest, `activeRepo === "B"`.
- [ ] **`ui` multi-repo:** `ui` with `watch.repos` starts a git+fs watcher per repo (banner lists them),
      the Now card lists both repos with the active one marked; `--no-watch` starts none.
- [ ] **No double-watch:** with `watch.repos` present, the legacy single `watch.git`/`watch.fs` watchers
      are NOT also started (no duplicate `git.commit` events for the same repo).
- [ ] `src/state/*`, `src/report/digest.ts`, `src/ui/page.ts`, `src/watchers/git.ts`, `src/watchers/fs.ts`,
      Planner/Worker/Executor/Synth/Autopilot/Advisor are **unchanged** (git diff empty for those paths).
- [ ] `.executive/` stays gitignored; only `src/config.ts`, `src/watchers/build.ts`,
      `src/watchers/build.test.ts`, `src/index.ts` (+ maybe `src/config.test.ts`) were created/edited.

---

## 6. Files to create / edit

### Create
```
src/watchers/build.ts
src/watchers/build.test.ts
```
### Edit
- `src/config.ts` — `watch.repos` type + normalization + name-collision handling.
- `src/index.ts` — `watch` + `ui` cases call `buildWatchers`; banner lists repos.
- `src/config.test.ts` — (if it exists) normalization/collision tests, else put them in `build.test.ts`.

Do NOT edit `src/state/*`, `src/report/*`, `src/ui/*`, `src/watchers/git.ts`, `src/watchers/fs.ts`, or any
planner/worker/executor/synth/auto/advisor file.

---

## 7. Deliverable

A commit containing §6's files + this doc. Do NOT commit `.executive/` runtime data. Hand back for
review — Claude runs every item in §5 and will NOT trust the self-report.

---

## 8. Design notes (rationale — not extra work)

- **Why so small:** the hard part (per-repo state derivation + display) was already built; the only real
  gap was that the daemon could construct just one watcher pair. This phase closes exactly that gap and
  nothing more — which is why it must NOT touch the already-working derivation/display code.
- **Why `buildWatchers` is extracted:** `watch` and `ui` both build the same list; putting multi-repo in
  one shared function avoids two divergent copies and makes the list unit-testable without booting a daemon.
- **Why names must be unique:** the State Builder keys its per-repo map by `name` and sets
  `currentProject` from it; a collision would merge two repos into one. Basename collisions are common
  (`~/work/api` and `~/play/api`), so the ` (2)` suffix + warning keeps them distinct and visible.
