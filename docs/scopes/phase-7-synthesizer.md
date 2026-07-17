# Scope — Phase 7: Synthesizer (Proposal → ChangeSet) (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

ExecutiveOS is an event-driven personal-assistant runtime. The pieces exist but do not yet connect:
- **Phase 5 Worker** produces a **`Proposal`** — prose `steps: string[]` describing what to do
  (persisted at `.executive/proposal.json`).
- **Phase 6 Executor** consumes a **`ChangeSet`** — executable file operations
  (`ops: FileOp[]`) — and applies them safely on an isolated branch.

**Phase 7 is the bridge.** It calls an LLM to turn a `Proposal` (prose) into a `ChangeSet` (executable
file ops), then runs the Executor **in dry-run** to show what would happen. This is the first time
reasoning output feeds toward repo mutation — so it is deliberately conservative.

**Core principle (do not violate):** the LLM is a reasoning engine (CPU) only. Phase 7 asks the LLM to
translate an already-decided intent into concrete file contents; the OS decides whether/what to feed it
and **validates everything it returns**. The LLM never touches the repo directly.

### CRITICAL — hard guardrails (a violation of any is a defect)

- **Dry-run only. NEVER auto-apply.** Phase 7 synthesizes a ChangeSet, writes it to
  `.executive/changeset.json`, and runs the Executor with `apply: false`. It **never** calls the
  Executor with `apply: true`. Applying stays a separate, explicit human step
  (`execute .executive/changeset.json --apply`).
- **The LLM's output is untrusted.** Parse it strictly, then run it through Phase 6's
  `validateChangeSet` (path safety: no `..`-escape, no absolute paths, no `.git`/`.executive`) BEFORE
  the Executor ever sees it. A ChangeSet that fails validation is reported and NOT executed (not even
  dry-run).
- **Token bounds.** The LLM only sees: the Proposal, a compact context summary, and the current
  contents of a **bounded** set of files (see §7). Cap per-file size and file count (config).
- **Do not edit Phase 5 or Phase 6.** Phase 7 imports their types/functions read-only. It does NOT
  modify `src/worker/*` or `src/executor/*`.
- **Reuse the existing backend + token.** The Synthesizer uses the same `config.worker` settings
  (backend / baseUrl / model / apiKey / gateway) as Phase 5 — no new gateway, no new token. Tests run
  100% offline via a `MockSynthesizer`.

### Out of scope (do NOT build)

- No auto-apply, no autonomous loop wiring, no `watch`-daemon integration.
- No refactor of Phase 5's Anthropic transport (a small, deliberate duplication is fine — see §7.2).
- No SQLite, no server, no new watchers.

---

## 1. Data flow

```
.executive/proposal.json (Phase 5)          selected files' current contents
        │                                            │  (--files, else from State)
        └───────────────┬────────────────────────────┘
                        ▼
              runSynth(opts)
                1. load proposal (latest, or --proposal <id>)
                2. select files (--files ?? State.currentFile+recentFiles), read them (bounded)
                3. Synthesizer.synthesize({proposal, files, summary}) → ChangeSet candidate  (LLM call)
                4. validateChangeSet(candidate, repoRoot)          ← Phase 6 path-safety gate
                5. write .executive/changeset.json (for inspection)
                6. if valid → applyChangeSet(candidate, { apply:FALSE })   ← Phase 6 DRY-RUN only
                7. write .executive/synth-report.json + print summary
                        ▼
        human reviews, then (separately): execute .executive/changeset.json --apply
```

---

## 2. Tech + constraints

- **Runtime:** Bun (latest). TypeScript (strict). No new runtime deps (global `fetch`, `node:fs`,
  `node:path`, `node:crypto`).
- Storage: JSON under `.executive/` only.
- Runs on Windows 11.
- **All tests OFFLINE** via `MockSynthesizer` — no network, no real LLM, no tokens. A test that hits the
  network is a defect.
- The owner cannot read Chinese — user-facing strings in Thai or English only (English for code/logs).

### Existing types/functions you MUST import read-only (do not redefine or edit)

- From `src/worker/types.ts`: `Proposal`.
- From `src/executor/types.ts`: `ChangeSet`, `FileOp`, `ValidationResult`, `ExecReport`.
- From `src/executor/validate.ts`: `validateChangeSet`.
- From `src/executor/executor.ts`: `applyChangeSet`.
- From `src/state/builder.ts`: `buildState` (to derive fallback files from State).
- From `src/config.ts`: `Config`.

---

## 3. Files to create / edit

### Create — `src/synth/`
```
src/synth/
├── types.ts        # SynthFile, SynthInput, SynthResult, Synthesizer, SynthReport, SynthOptions
├── mock.ts         # MockSynthesizer — deterministic, offline
├── anthropic.ts    # AnthropicSynthesizer (LLM call) + pure helpers (buildSynthSystemPrompt,
│                   #   buildSynthUserMessage, buildSynthRequestBody, parseChangeSetJson)
├── factory.ts      # createSynthesizer(config) — mock | anthropic (mirrors config.worker.backend)
├── synth.ts        # runSynth(opts): orchestrator + selectFiles + assembleFiles + writeChangeSet + writeSynthReport
└── synth.test.ts   # offline tests
```

### Edit
- `src/paths.ts` — add `changeSetPath()` and `synthReportPath()`.
- `src/config.ts` — add the optional `synth` config block + backward-compatible merge.
- `src/index.ts` — add the `synth` CLI command; update `--help`.

Do NOT edit any other file. In particular do NOT touch `src/worker/*`, `src/executor/*`,
`src/planner/*`, `src/state/*`. Do NOT wire anything into the `watch` daemon.

---

## 4. Types (`src/synth/types.ts`)

```ts
import type { Proposal } from "../worker/types.js";
import type { ChangeSet, ValidationResult, ExecReport } from "../executor/types.js";
import type { Config } from "../config.js";

/** One existing file's current content, handed to the LLM as material. */
export interface SynthFile {
  path: string;    // repo-relative
  content: string; // current content
  bytes: number;   // Buffer.byteLength(content, "utf8")
}

/** What the OS hands the LLM to synthesize a ChangeSet. */
export interface SynthInput {
  proposal: Proposal;   // the intent (prose steps) from Phase 5
  summary: string;      // compact context summary
  files: SynthFile[];   // current contents of the selected (bounded) files
}

/** A Synthesizer's raw output — the candidate ChangeSet before validation. */
export interface SynthResult {
  changeSet: ChangeSet; // parsed candidate (NOT yet validated)
  raw: string;          // raw model text, kept verbatim for inspectability
  backend: string;      // the Synthesizer.name that produced it
}

/**
 * Turns a SynthInput into a candidate ChangeSet.
 * MockSynthesizer (offline, deterministic) and AnthropicSynthesizer (HTTP).
 * `synthesize` may throw on transport/parse errors — runSynth catches and records it.
 */
export interface Synthesizer {
  readonly name: string; // e.g. "mock" or "anthropic:qwen3.6-35b-a3b"
  synthesize(input: SynthInput): Promise<SynthResult>;
}

export interface SynthOptions {
  repoRoot: string;
  config: Config;
  explicitFiles?: string[];      // from --files; when absent, fall back to State
  proposalId?: string | null;    // from --proposal; when absent, use the latest proposal.json
  synthOverride?: Synthesizer;   // tests inject a Synthesizer; production passes nothing
}

export interface SynthReport {
  ok: boolean;
  proposalId: string | null;
  synthesizer: string | null;
  selectedFiles: string[];       // paths actually fed to the LLM
  changeSetWritten: boolean;     // whether .executive/changeset.json was written
  validation: ValidationResult;  // result of validateChangeSet on the candidate
  execReport: ExecReport | null; // Phase 6 DRY-RUN report (null if validation failed or synth failed)
  messages: string[];
  error: string | null;          // set when the Synthesizer threw
  generatedAt: string;           // ISO
}
```

---

## 5. Paths (`src/paths.ts` — additions only)

```ts
/** Absolute path to .executive/changeset.json (the latest synthesized ChangeSet). */
export function changeSetPath(): string {
  return execRoot() + "/changeset.json";
}

/** Absolute path to .executive/synth-report.json (the latest Synthesizer report). */
export function synthReportPath(): string {
  return execRoot() + "/synth-report.json";
}
```

---

## 6. Config (`src/config.ts` — additions only)

Add to the `Config` interface:

```ts
  /** Synthesizer configuration (defaults applied when absent). */
  synth?: {
    maxFileBytes?: number; // skip any single file larger than this (token bound); default 100000
    maxFiles?: number;     // cap on number of files fed to the LLM; default 10
  };
```

`defaultConfig()`:

```ts
    synth: {
      maxFileBytes: 100000,
      maxFiles: 10,
    },
```

`loadConfig()` — after the `executor` merge, add a backward-compatible `synth` merge (same style):

```ts
  if (!parsed.synth) {
    parsed.synth = defaults.synth!;
  }
  parsed.synth.maxFileBytes = parsed.synth.maxFileBytes ?? defaults.synth!.maxFileBytes!;
  parsed.synth.maxFiles = parsed.synth.maxFiles ?? defaults.synth!.maxFiles!;
```

> The Synthesizer's **backend/model/token come from the existing `config.worker` block** (same gateway
> as Phase 5). `config.synth` only bounds how much file material is sent.

---

## 7. The Synthesizers

### 7.1 `MockSynthesizer` (`src/synth/mock.ts`) — deterministic, offline

```ts
export class MockSynthesizer implements Synthesizer {
  readonly name = "mock";
  async synthesize(input: SynthInput): Promise<SynthResult>;
}
```

Deterministic (no clock, no randomness, no network). Produce a **valid** ChangeSet derived from the
input: `id` from the proposal's action kind + a fixed suffix (e.g. `"synth-" + input.proposal.action.kind`),
`title` = `"synthesized: " + input.proposal.summary`, a single `write` op to a fixed repo-root path
`SYNTH_NOTE.md` whose content lists the proposal summary + steps, `test: null`, `commitMessage` derived
from the title. `raw` = `JSON.stringify(changeSet)`. This lets the full pipeline (validate → dry-run
executor) be tested offline. Provide the deterministic ChangeSet exactly so tests can assert it.

### 7.2 `AnthropicSynthesizer` (`src/synth/anthropic.ts`) — HTTP, strict-JSON

Mirrors Phase 5's `AnthropicWorker` shape (Anthropic Messages API, `POST {baseUrl}/v1/messages`), but
its prompt demands a **strict JSON ChangeSet** and it parses that JSON. It is a small, self-contained
copy of the transport (do NOT refactor Phase 5 to share it).

- Constructor takes `{ baseUrl, model, apiKey, maxTokens, timeoutMs }` (resolved from `config.worker`).
- `name` = `"anthropic:" + model`.
- `synthesize(input)`: POST to `baseUrl.replace(/\/+$/,"") + "/v1/messages"` with headers
  `{ "Content-Type": "application/json", "anthropic-version": "2023-06-01" }` plus
  `{ "Authorization": "Bearer " + apiKey }` when `apiKey` is non-empty; `AbortController` timeout
  cleared in `finally`; non-2xx → throw `"synth HTTP <status>: <body, truncated ~500>"`; on success
  read `content[].text` (concatenate text blocks; throw `"synth: no text in response"` if none), then
  `parseChangeSetJson(text)`.
- **Pure exported helpers** (unit-tested without network):
  - `buildSynthSystemPrompt(): string` — instructs: you convert an approved Proposal into a ChangeSet.
    Output **ONLY** a single JSON object (no prose, no markdown fences) with this exact shape:
    `{ "id": string (^[A-Za-z0-9._-]+$), "title": string, "commitMessage": string, "test": string|null,
    "ops": [ {"op":"write"|"create"|"delete","path": repo-relative string, "content": string (for
    write/create) } ] }`. Rules to state: paths are repo-relative, never absolute, never `..`, never
    under `.git`/`.executive`; for `write`/`create` include the **entire** new file content; keep the
    change minimal and focused on the Proposal.
  - `buildSynthUserMessage(input): string` — deterministic `JSON.stringify` of
    `{ proposal: { summary, steps, action }, summary: input.summary, files: input.files }`.
  - `buildSynthRequestBody(input, model, maxTokens): object` — Anthropic body: `{ model, max_tokens,
    temperature: 0, system: buildSynthSystemPrompt(), messages: [{ role: "user", content:
    buildSynthUserMessage(input) }] }`.
  - `parseChangeSetJson(text): ChangeSet` — lenient extraction: strip leading/trailing markdown fences
    (```` ```json ```` / ```` ``` ````), take the substring from the first `{` to the last `}`,
    `JSON.parse`. Then coerce into a well-formed candidate: if `id` missing/empty → derive a safe id
    (`"synth-" + Date-free fallback`, e.g. slugify title to `^[A-Za-z0-9._-]+$`, else `"synth"`); if
    `test` missing → `null`; if `commitMessage` missing → use `title`; ensure `ops` is an array (if
    missing → `[]`). Throw `"synth: could not parse ChangeSet JSON"` when `JSON.parse` fails. Return the
    candidate (do NOT validate here — runSynth calls `validateChangeSet`).

> The candidate from `parseChangeSetJson` is a best-effort object; **safety is enforced by
> `validateChangeSet` in `runSynth`, not here.**

### 7.3 `createSynthesizer` (`src/synth/factory.ts`)

```ts
export function createSynthesizer(config: Config): Synthesizer {
  const w = config.worker!;                    // reuse the Phase 5 backend config
  if (w.backend === "mock") return new MockSynthesizer();
  const apiKey = w.apiKeyEnv ? (process.env[w.apiKeyEnv] ?? "") : "";
  return new AnthropicSynthesizer({
    baseUrl: w.baseUrl!, model: w.model!, apiKey, maxTokens: w.maxTokens!, timeoutMs: w.timeoutMs!,
  });
}
```

---

## 8. Orchestrator (`src/synth/synth.ts`)

```ts
export async function runSynth(opts: SynthOptions): Promise<SynthReport>;
export function writeChangeSet(cs: ChangeSet): void;   // atomic temp+rename → changeSetPath()
export function writeSynthReport(r: SynthReport): void; // atomic temp+rename → synthReportPath()
```

`runSynth` behavior — **in this exact order**:

1. **Load the proposal.** If `opts.proposalId` given → read `.executive/proposals/<id>.json`; else read
   `.executive/proposal.json`. If missing/unreadable → return `ok:false`, message
   `"no proposal found — run \`work\` first"`, `error:null`.
   If `proposal.status !== "ok"` → return `ok:false`, message `"proposal has no actionable steps
   (status: <status>)"`.
2. **Select files.**
   - If `opts.explicitFiles` is a non-empty array → use it.
   - Else derive from State: `const s = buildState().state;` → `[s.currentFile, ...s.recentFiles]`,
     drop nulls, dedupe, preserve order.
   - Cap the list to `config.synth.maxFiles`.
3. **Assemble file material.** For each selected path: resolve against `repoRoot`; skip (with a message)
   if it does not exist; skip (with a message) if its byte size > `config.synth.maxFileBytes`; otherwise
   read it into a `SynthFile`. `selectedFiles` in the report = the paths actually included.
4. **Summary.** Use the proposal's own `summary` (do not rebuild context — keep it cheap). Set
   `input = { proposal, summary: proposal.summary, files }`.
5. **Synthesize.** `synth = opts.synthOverride ?? createSynthesizer(config)`. `try { result = await
   synth.synthesize(input) } catch (err) { return ok:false, error: err.message, message "synthesizer
   failed" }` (no disk write on failure).
6. **Write the candidate** to `.executive/changeset.json` (always, for inspection) →
   `changeSetWritten = true`. Record `synthesizer = result.backend`.
7. **Validate.** `validation = validateChangeSet(result.changeSet, repoRoot)`. If `!validation.ok` →
   `ok:false`, push each error to `messages`, `execReport: null`, return (do NOT run the Executor).
8. **Dry-run the Executor.** `execReport = applyChangeSet(result.changeSet, { apply: false, repoRoot,
   config })`. **Never `apply: true`.** `ok = execReport.ok` (all planned ops would succeed). Push a
   message reminding: `"review .executive/changeset.json, then: execute .executive/changeset.json
   --apply"`.
9. Fill `generatedAt`, return the `SynthReport`.

`writeChangeSet` / `writeSynthReport`: atomic temp+rename (same pattern as `writeProposal`/`writePlan`/
`writeReport`), `JSON.stringify(x, null, 2) + "\n"`.

---

## 9. CLI (`src/index.ts`)

### New `synth` command

```
bun run src/index.ts synth [--files a.ts,b.ts] [--proposal <id>]
```

Steps:
1. `await bootstrap(); const config = loadConfig();`
2. Parse flags: `--files <csv>` → `explicitFiles` (split on `,`, trim, drop empties); `--proposal <id>`
   → `proposalId`. Hand-rolled parse consistent with the existing CLI (no framework).
3. `const report = await runSynth({ repoRoot: process.cwd(), config, explicitFiles, proposalId });`
4. `writeSynthReport(report);`
5. Print a concise summary: proposal id, synthesizer, selected files, validation ok/errors, the dry-run
   plan (each planned op line, when present), `changeSetPath()`, and the apply reminder.
6. Exit `0` when `report.ok`, else `1`. (A synth transport failure is captured in the report, but sets
   `ok:false` → exit 1; the process never throws uncaught.)

Add to `printUsage()`:
```
  synth [--files a,b] [--proposal <id>]         Synthesize a ChangeSet from the latest Proposal (dry-run; does NOT apply)
```

---

## 10. Tests (`src/synth/synth.test.ts`) — required, `bun test`, OFFLINE

Set `EXECUTIVE_HOME` to a fresh temp dir per test; clean up after. Build small `Proposal` fixtures and
write them to `.executive/proposal.json` as needed. For pipeline tests that hit the Executor dry-run,
create a temp git repo (offline). Cover at minimum:

1. **MockSynthesizer deterministic:** same input twice → identical `SynthResult`; the ChangeSet passes
   `validateChangeSet`.
2. **parseChangeSetJson:** parses a fenced ```` ```json {…} ``` ```` block; fills defaults for missing
   `test`/`commitMessage`/`id`; throws on non-JSON garbage.
3. **buildSynthRequestBody:** Anthropic shape — top-level `system` string, single `user` message,
   `temperature: 0`, `model`/`max_tokens` set.
4. **selectFiles — explicit wins:** `explicitFiles: ["a.ts"]` → the report's `selectedFiles` reflects
   the explicit list (existing files only), NOT State.
5. **selectFiles — fallback to State:** no `explicitFiles` → files come from State
   (`currentFile`+`recentFiles`). (Seed events / a state so buildState yields a file.)
6. **assembleFiles bounds:** an oversized file (> maxFileBytes) is skipped with a message; a missing
   file is skipped with a message.
7. **runSynth happy path (injected MockSynthesizer, temp git repo):** writes `.executive/changeset.json`,
   `validation.ok === true`, `execReport` present with `mode: "dry-run"`, `ok: true`, and **the repo is
   NOT mutated** (no `executive/change-*` branch, working tree clean).
8. **runSynth — no proposal:** returns `ok:false`, message mentions "no proposal", nothing written.
9. **runSynth — synthesizer throws:** injected synth whose `synthesize` throws → `ok:false`,
   `error` set, no `changeset.json` written.
10. **runSynth — unsafe ChangeSet rejected:** injected synth returns a ChangeSet with a `../escape` path
    → `validation.ok === false`, `execReport === null`, `ok:false`, and **no Executor mutation**
    (the changeset.json is still written for inspection, but never executed).
11. **runSynth never applies:** assert that in the happy path no branch is created and the Executor was
    called in dry-run (verify via git: no `executive/change-*` branch exists).

All 97 existing tests must still pass. **No test may perform a network request.**

---

## 11. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes (strict).
- [ ] `bun test` passes — existing 97 + new Synthesizer tests, offline.
- [ ] With `config.worker.backend = "mock"`, a `.executive/proposal.json` present, in a temp git repo:
      `synth` writes `.executive/changeset.json`, prints a dry-run plan, exits `0`, and **mutates the
      repo NOTHING** (no `executive/change-*` branch, working tree clean).
- [ ] `synth` with no proposal present → clear message, exit `1`, nothing written.
- [ ] A (mock) synthesizer returning an unsafe path (`../x`, absolute, `.git/…`, `.executive/…`) →
      validation rejects it, the Executor is NOT run, exit `1`, no mutation.
- [ ] `synth --files src/index.ts` feeds exactly that file (report `selectedFiles`); with no `--files`,
      files come from State.
- [ ] The Synthesizer reuses `config.worker` (no separate backend/token config); `backend: "mock"`
      selects `MockSynthesizer`, `backend: "anthropic"` selects `AnthropicSynthesizer`.
- [ ] Phase 7 NEVER calls the Executor with `apply: true` (grep `src/synth/` — only `apply: false`).
- [ ] `src/worker/*` and `src/executor/*` are unchanged; nothing wired into the `watch` daemon.
- [ ] `.executive/changeset.json` and `.executive/synth-report.json` are gitignored.
- [ ] Only the files listed in §3 were created/edited.

---

## 12. Deliverable

A commit containing `src/synth/` and the three edits (`paths.ts`, `config.ts`, `index.ts`), plus this
doc. Do NOT commit `.executive/` runtime data. When done, hand back for review — Claude will run every
item in §11 and will NOT trust the self-report.
