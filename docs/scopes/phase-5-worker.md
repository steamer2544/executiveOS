# Scope — Phase 5: Claude/LLM Worker (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

ExecutiveOS is an event-driven personal-assistant runtime. Previous phases built the OS around the
LLM: an event store (Phase 1), an event bus + watchers (Phase 2), a rule-based **State Builder**
(Phase 3), and a rule-based **Planner** (Phase 4). **Phase 5 is the FIRST phase where an LLM enters
the system.**

The Planner (Phase 4) decides *"what is the highest-value action now?"* and emits `plan.json` with a
`topAction`. Phase 5 adds the **Worker**: when — and ONLY when — the Planner's `topAction` is
disposition `"act"`, the Worker calls an LLM to turn that abstract action into a **concrete, reasoned
Proposal** (a short list of suggested steps / commands), and persists it for a human to inspect.

**Core principle (do not violate):** the LLM is a reasoning engine (CPU) only. The OS decides *whether*
to call it and *what* to feed it; the LLM only reasons about the single action handed to it.

### CRITICAL — what Phase 5 does NOT do

- **It does NOT execute anything.** No `git`, no running tests, no applying patches, no commits, no
  shell commands, no filesystem mutation of the user's repo. The Worker **only reads** the already-built
  `context.json` and **only writes** a Proposal file under `.executive/`. Executing a Proposal is a
  LATER phase (Phase 6), gated behind explicit human approval.
- **It does NOT read arbitrary repo files.** The Worker's entire input is the Phase 3 `Context` object
  (which already embeds `State` + recent events + a summary). It does not open source files, walk the
  tree, or fetch anything beyond the one LLM call. This bounds token usage to a predictable size.
- **It does NOT change the Planner or State Builder.** Those are done. The Worker reads their JSON
  outputs; it never re-derives state or re-runs rules.
- **It does NOT introduce SQLite, a web server, MCP, or new watchers.** Storage is still JSONL/JSON.

If you are tempted to add any of the above — **STOP. Out of scope.**

---

## 1. Where this fits (data flow)

```
events/*.jsonl ──▶ buildState() ──▶ state.json
                                └──▶ context.json ─┐
                    plan(state) ──▶ plan.json ─────┤
                                                   ▼
                                   runWorker(context, plan, config)
                                       │  (only if plan.topAction.disposition === "act")
                                       ▼
                                   LLM call (Anthropic Messages API) ──▶ Proposal
                                       ▼
                       .executive/proposal.json  (latest)
                       .executive/proposals/<id>.json  (history)
```

The Worker is invoked in two places (both added in this phase):
- **CLI:** a new `work` command (build state → plan → maybe call Worker → write Proposal).
- **`watch` daemon:** after each plan rebuild, IF `config.worker.autoInvoke === true`, call the Worker
  (default is `false` → the daemon does NOT auto-call the LLM).

---

## 2. Tech + constraints (unchanged from prior phases)

- **Runtime:** Bun (latest). Language: TypeScript (strict). No new runtime dependencies — use Bun's
  built-in global `fetch` for the HTTP call, `node:crypto`, `node:fs`. Dev deps (`typescript`,
  `@types/bun`) already present.
- Storage: JSONL/JSON files under `.executive/` only. No SQLite.
- Runs on Windows 11. Paths inside `.executive/` are joined with `/` (matches existing `paths.ts`).
- **All tests must run 100% OFFLINE** — no network, no real LLM, no tokens spent. Tests use a
  deterministic `MockWorker`. A test that hits the network is a defect.
- The owner cannot read Chinese — any user-facing strings in Thai or English only (English preferred
  for code/log strings, matching existing files).

### Existing types you MUST import and reuse (do not redefine)

From `src/state/types.ts`:
```ts
export interface State { generatedAt: string; eventCount: number; lastEventTs: string | null;
  currentProject: string | null; currentTask: string | null; deadline: string | null;
  currentFile: string | null; recentFiles: string[];
  git: { branch: string | null; lastCommit: CommitInfo | null };
  tests: "passing" | "failing" | "unknown"; blocked: boolean; blockedReason: string | null;
  activity: { active: boolean; idleMs: number | null }; }
export interface Context { generatedAt: string; summary: string; state: State;
  recentEvents: Array<{ seq: number; ts: string; source: string; type: string; data: Record<string, unknown> }>; }
```

From `src/planner/types.ts`:
```ts
export type ActionKind = "fix_tests" | "resolve_block" | "review_deadline" | "resume_task";
export type Disposition = "act" | "ask";
export interface ProposedAction { kind: ActionKind; reason: string; priority: number;
  confidence: number; forbidden: boolean; disposition?: Disposition; }
export interface Plan { generatedAt: string; basedOnState: { generatedAt: string; eventCount: number };
  topAction: ProposedAction | null; actions: ProposedAction[]; summary: string; }
```

---

## 3. Files to create / edit

### Create — `src/worker/`
```
src/worker/
├── types.ts          # Worker interface, WorkerInput, WorkerOutput, Proposal
├── mock.ts           # MockWorker — deterministic, offline, no network
├── anthropic.ts      # AnthropicWorker (fetch-based, Anthropic Messages API) + pure helpers
├── factory.ts        # createWorker(config) → Worker (selects backend)
├── orchestrator.ts   # runWorker(...) + writeProposal(...)
└── worker.test.ts    # offline unit tests (see §9)
```

### Edit
- `src/paths.ts` — add `proposalsDir()` and `proposalPath()`.
- `src/config.ts` — add the optional `worker` config block + backward-compatible merge.
- `src/index.ts` — add the `work` CLI command; wire optional Worker call into the `watch` daemon;
  update `--help`.

Do NOT edit any other file. In particular do NOT touch `src/planner/*`, `src/state/*`,
`src/events/*`, `src/watchers/*`, `src/bus.ts`, `src/sink.ts`, `src/bootstrap.ts`.

---

## 4. Types (`src/worker/types.ts`)

```ts
import type { Context } from "../state/types.js";
import type { ActionKind, ProposedAction } from "../planner/types.js";

/** What the OS hands the LLM: the one action to reason about + the full context snapshot. */
export interface WorkerInput {
  action: ProposedAction;   // the plan.topAction (guaranteed disposition "act" by the orchestrator)
  context: Context;         // Phase 3 context.json (state + recent events + summary)
}

/** What a Worker returns from a successful run. */
export interface WorkerOutput {
  summary: string;    // one-line rollup of the proposal
  steps: string[];    // concrete suggested steps (human executes; NOT run here)
  raw: string;        // the raw model text, kept verbatim for inspectability
}

/**
 * A Worker turns a WorkerInput into a WorkerOutput.
 * Implementations: MockWorker (offline, deterministic) and AnthropicWorker (HTTP).
 * `run` may throw on transport/timeout errors — the orchestrator catches and records it.
 */
export interface Worker {
  readonly name: string;   // e.g. "mock" or "anthropic:qwen3.6-35b-a3b"
  run(input: WorkerInput): Promise<WorkerOutput>;
}

/** The persisted artifact of a Worker run (written to .executive/). */
export interface Proposal {
  id: string;                 // crypto.randomUUID()
  generatedAt: string;        // ISO, when this proposal was produced
  status: "ok" | "error";     // "error" when the Worker threw
  backend: string;            // the Worker.name that produced it
  action: ProposedAction;     // echo of the topAction, for provenance
  summary: string;            // one-line ("error: ..." when status === "error")
  steps: string[];            // suggested steps ([] when status === "error")
  raw: string;                // raw model text ("" when status === "error")
  error: string | null;       // error message when status === "error", else null
  basedOn: {                  // provenance back to the inputs
    stateGeneratedAt: string; // context.state.generatedAt
    topActionKind: ActionKind;
  };
}
```

---

## 5. Paths (`src/paths.ts` — additions only)

Append two helpers, same style as the existing ones:

```ts
/** Absolute path to .executive/proposals/ (proposal history). */
export function proposalsDir(): string {
  return execRoot() + "/proposals";
}

/** Absolute path to .executive/proposal.json (the latest proposal). */
export function proposalPath(): string {
  return execRoot() + "/proposal.json";
}
```

Do not change any existing path helper.

---

## 6. Config (`src/config.ts` — additions only)

Add an optional `worker` block to the `Config` interface:

```ts
  /** Worker (LLM) configuration (defaults applied when absent). */
  worker?: {
    backend?: "mock" | "anthropic"; // which Worker to build
    baseUrl?: string;    // Anthropic-compatible gateway base (NO trailing /v1), e.g. "https://gateway.9arm.co"
    model?: string;      // model name, e.g. "qwen3.6-35b-a3b"
    apiKeyEnv?: string;  // NAME of the env var holding the auth token (never the token itself)
    maxTokens?: number;  // cap on completion length
    timeoutMs?: number;  // request timeout
    autoInvoke?: boolean;// if true, the watch daemon calls the Worker automatically
  };
```

In `defaultConfig()` add:

```ts
    worker: {
      backend: "anthropic",
      baseUrl: "https://gateway.9arm.co",
      model: "qwen3.6-35b-a3b",
      apiKeyEnv: "EXECUTIVE_WORKER_KEY",
      maxTokens: 1024,
      timeoutMs: 30000,
      autoInvoke: false,
    },
```

> Rationale for these defaults (do not change the field names/structure): the default backend is the
> owner's **remote shared inference server** ("claude9arm" — a `qwen3.6-35b-a3b` instance hosted by a
> third party at `https://gateway.9arm.co`, reached over the network and **requiring an auth token**).
> The `baseUrl` is a public URL and is safe to ship. The **token is a secret** and is NEVER placed in
> source or in the default config: it is read at runtime from the environment variable named by
> `apiKeyEnv` (default `EXECUTIVE_WORKER_KEY`). `autoInvoke: false` means the long-running `watch`
> daemon will NOT call the LLM on its own — the owner runs `work` manually, or opts into autonomy by
> setting it `true`.
>
> **Protocol — confirmed, do not assume otherwise:** the 9arm gateway speaks the **Anthropic Messages
> API** (`POST {baseUrl}/v1/messages`, header `anthropic-version`, body with top-level `system` +
> `messages`, response `content[].text`). It is the endpoint the `claude` CLI is pointed at via
> `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`. It is **NOT** OpenAI `/v1/chat/completions`. Build the
> adapter to the Anthropic shape (§7.2). Support for an OpenAI-compatible host (e.g. DeepSeek) is a
> future backend behind the same `Worker` interface — **out of scope for Phase 5**.

In `loadConfig()`, after the existing `state` merge, add a **backward-compatible** `worker` merge in
the same field-by-field style (so a Phase 1–4 config with no `worker` key still loads):

```ts
  // Merge missing worker fields with defaults.
  if (!parsed.worker) {
    parsed.worker = defaults.worker!;
  }
  parsed.worker.backend   = parsed.worker.backend   ?? defaults.worker!.backend!;
  parsed.worker.baseUrl   = parsed.worker.baseUrl   ?? defaults.worker!.baseUrl!;
  parsed.worker.model     = parsed.worker.model     ?? defaults.worker!.model!;
  parsed.worker.apiKeyEnv = parsed.worker.apiKeyEnv ?? defaults.worker!.apiKeyEnv!;
  parsed.worker.maxTokens = parsed.worker.maxTokens ?? defaults.worker!.maxTokens!;
  parsed.worker.timeoutMs = parsed.worker.timeoutMs ?? defaults.worker!.timeoutMs!;
  parsed.worker.autoInvoke = parsed.worker.autoInvoke ?? defaults.worker!.autoInvoke!;
```

---

## 7. The Workers

### 7.1 `MockWorker` (`src/worker/mock.ts`) — deterministic, offline

```ts
import type { Worker, WorkerInput, WorkerOutput } from "./types.js";

/**
 * Deterministic, offline Worker. No network, no randomness, no clock.
 * Same input → same output. Used by tests and by `config.worker.backend === "mock"`.
 */
export class MockWorker implements Worker {
  readonly name = "mock";
  async run(input: WorkerInput): Promise<WorkerOutput> {
    const kind = input.action.kind;
    const steps = MOCK_STEPS[kind]; // a fixed, small string[] per ActionKind
    return {
      summary: `[mock] proposal for ${kind}`,
      steps,
      raw: steps.join("\n"),
    };
  }
}
```

Provide a `MOCK_STEPS: Record<ActionKind, string[]>` with 2–3 short, plausible steps per kind
(e.g. for `fix_tests`: `["Run the failing test suite to see the error", "Locate the assertion that
fails", "Patch the code, re-run until green"]`). Keep them generic and deterministic. No I/O.

### 7.2 `AnthropicWorker` (`src/worker/anthropic.ts`) — HTTP, Anthropic Messages API

Implements `Worker` by POSTing to `${baseUrl}/v1/messages` (the 9arm gateway shape). Requirements:

- Constructor takes `{ baseUrl, model, apiKey, maxTokens, timeoutMs }` (all resolved values — the
  factory reads the env var and passes the actual token string, or `""` if unset).
- `name` = `"anthropic:" + model`.
- `run(input)`:
  - URL = `baseUrl.replace(/\/+$/, "") + "/v1/messages"` (tolerate a trailing slash on `baseUrl`).
  - Build the request body with `buildRequestBody(input, model, maxTokens)` (a **pure exported
    helper** — see below). Body shape (Anthropic Messages API):
    ```json
    { "model": "...", "max_tokens": 1024, "temperature": 0,
      "system": "<SYSTEM_PROMPT>",
      "messages": [ { "role": "user", "content": "<serialized input>" } ] }
    ```
  - `temperature: 0` for determinism.
  - Use `fetch(url, { method: "POST", headers, body, signal })`.
    - Headers: `{ "Content-Type": "application/json", "anthropic-version": "2023-06-01" }`, plus
      `{ "Authorization": "Bearer " + apiKey }` **only if `apiKey` is non-empty**.
      (The gateway is fed via `ANTHROPIC_AUTH_TOKEN`, which maps to `Authorization: Bearer`.)
    - `signal` from an `AbortController` armed with `setTimeout(..., timeoutMs)`; clear the timer in a
      `finally`.
  - On non-2xx response: throw `new Error("worker HTTP " + res.status + ": " + <body text, truncated to ~500 chars>)`.
  - On success: parse JSON and extract the text with `parseAnthropicResponse(json)` (pure helper),
    then return `parseCompletion(text)` (pure helper).
- **Pure exported helpers** (so they can be unit-tested without network):
  - `buildSystemPrompt(): string` — a short, fixed system prompt. It MUST state: you are the Worker
    (CPU) of an OS; you are given ONE action and a context snapshot; propose concrete steps to carry
    out that action; **you do NOT execute anything**; keep it concise; output steps as short lines.
  - `buildUserMessage(input: WorkerInput): string` — deterministic serialization of the action +
    a compact view of the context (e.g. `JSON.stringify({ action, summary: context.summary, state:
    context.state, recentEvents: context.recentEvents }, null, 2)`). No clock, no randomness.
  - `buildRequestBody(input, model, maxTokens): object` — assembles the full body from the two above
    (top-level `system` string + single `user` message — NOT an OpenAI `messages[0].role==="system"`).
  - `parseAnthropicResponse(json: unknown): string` — from an Anthropic response, concatenate the
    `text` of every block in `content` where `block.type === "text"`. If `content` is missing/not an
    array or has no text blocks, throw `new Error("worker: no text in response")`.
  - `parseCompletion(text: string): WorkerOutput` — `summary` = first non-empty line (trimmed);
    `steps` = all non-empty trimmed lines (strip a leading `-`, `*`, or `1.`/`2.` bullet if present);
    `raw` = the original `text`. If `text` is empty/whitespace, return
    `{ summary: "(empty completion)", steps: [], raw: text }`.

> The network call itself is NOT unit-tested (integration only). The pure helpers ARE unit-tested.

### 7.3 `createWorker` (`src/worker/factory.ts`)

```ts
import type { Config } from "../config.js";
import type { Worker } from "./types.js";
import { MockWorker } from "./mock.js";
import { AnthropicWorker } from "./anthropic.js";

/** Build the Worker selected by config.worker.backend. Reads the auth token from the named env var. */
export function createWorker(config: Config): Worker {
  const w = config.worker!; // loadConfig() guarantees this is populated
  if (w.backend === "mock") return new MockWorker();
  // "anthropic"
  const apiKey = w.apiKeyEnv ? (process.env[w.apiKeyEnv] ?? "") : "";
  return new AnthropicWorker({
    baseUrl: w.baseUrl!, model: w.model!, apiKey,
    maxTokens: w.maxTokens!, timeoutMs: w.timeoutMs!,
  });
}
```

---

## 8. Orchestrator (`src/worker/orchestrator.ts`) — the guardrailed entry point

This is the ONLY place the rest of the system calls into the Worker.

```ts
export async function runWorker(
  context: Context,
  plan: Plan,
  config: Config,
  workerOverride?: Worker,   // tests inject a Worker here; production passes nothing
): Promise<Proposal | null>;
```

Behavior — **in this exact order**:

1. **Guardrail gate (defense in depth — re-check even though the Planner already set disposition):**
   - If `plan.topAction === null` → return `null` (nothing to do).
   - If `plan.topAction.forbidden === true` → return `null` (never invoke the LLM on a forbidden action).
   - If `plan.topAction.disposition !== "act"` → return `null` (an `"ask"` action waits for a human;
     the LLM is not called).
2. Resolve the worker: `const worker = workerOverride ?? createWorker(config);`
3. Call it, wrapping failures:
   ```ts
   try {
     const out = await worker.run({ action: plan.topAction, context });
     return buildProposal("ok", worker.name, plan.topAction, context, out, null);
   } catch (err) {
     return buildProposal("error", worker.name, plan.topAction, context,
       { summary: "", steps: [], raw: "" }, (err as Error).message);
   }
   ```
4. `buildProposal(...)` assembles a `Proposal`: `id` = `randomUUID()`, `generatedAt` =
   `new Date().toISOString()`, `basedOn = { stateGeneratedAt: context.state.generatedAt,
   topActionKind: action.kind }`. For `status: "error"`, `summary = "error: " + error`.

> Note: `runWorker` returns `null` when there is nothing to act on — that is a normal, non-error
> outcome, not a failure.

### `writeProposal(p: Proposal): void`

Atomic write, same temp-file + `renameSync` pattern as `writePlan`/`writeState`:
- Ensure `proposalsDir()` exists (`mkdirSync(..., { recursive: true })`).
- Write the history copy to `proposalsDir() + "/" + p.id + ".json"` (temp + rename).
- Write the latest pointer to `proposalPath()` (temp + rename).
- Both files: `JSON.stringify(p, null, 2) + "\n"`.

---

## 9. CLI + daemon wiring (`src/index.ts`)

### 9.1 New `work` command

```
bun run src/index.ts work
```
Steps:
1. `await bootstrap();`
2. `const config = loadConfig();`
3. `const built = buildState(); writeState(built);`
4. `const p = plan(built.state, built.context); writePlan(p);`
5. `const proposal = await runWorker(built.context, p, config);`
6. Output:
   - If `proposal === null` → print `"No actionable topAction (nothing to do or disposition=ask)."`
     and exit `0`.
   - Else → `writeProposal(proposal);` then print
     `proposalPath() + " — [" + proposal.status + "] " + proposal.summary`. Exit `0`.
7. Wrap in try/catch like the existing `plan` command: on throw, print `"Error: " + message` to
   stderr and exit `1`. (A Worker transport failure is captured as a `status: "error"` Proposal, NOT
   a thrown error — so the normal path still exits `0` with an error-Proposal written.)

> `built` refers to the object returned by `buildState()`; reuse the same access pattern the existing
> `plan` command uses (`built.state`, `built.context`).

### 9.2 `watch` daemon — optional auto-invoke

In the daemon, after each successful plan rebuild (both the startup rebuild and the interval rebuild),
add:

```ts
if (config.worker?.autoInvoke === true) {
  try {
    const proposal = await runWorker(built.context, p, config);
    if (proposal) {
      writeProposal(proposal);
      process.stdout.write("Worker: [" + proposal.status + "] " + proposal.summary + "\n");
    }
  } catch (workerErr) {
    // A Worker failure NEVER crashes the daemon.
    process.stderr.write("Worker failed: " + (workerErr as Error).message + "\n");
  }
}
```

- Default config has `autoInvoke: false`, so by default the daemon does **not** call the LLM.
- Do NOT add a new timer — reuse the existing state-rebuild timing.
- The interval callback is currently a synchronous `setInterval(() => {...})`. You may make that
  callback `async` (i.e. `setInterval(async () => {...})`) to `await runWorker`; keep every existing
  try/catch intact so nothing crashes the daemon.

### 9.3 Help text

Add `work` to `printUsage()`:
```
  work                                          Build state + plan, then run the Worker if actionable
```

---

## 10. Tests (`src/worker/worker.test.ts`) — required, must pass with `bun test`, fully OFFLINE

Set `EXECUTIVE_HOME` to a fresh temp dir in `beforeEach` and clean it in `afterEach` (same pattern as
existing tests) so tests never touch the real `.executive/`. Build small `Context`/`Plan`/`State`
fixtures inline. Cover at minimum:

1. **MockWorker is deterministic:** `run` on the same input twice returns identical output; `steps`
   is non-empty for every `ActionKind`.
2. **Orchestrator gate — null topAction:** `runWorker(context, planWithNullTop, config)` → `null`.
3. **Orchestrator gate — disposition "ask":** a `topAction` with `disposition: "ask"` → `runWorker`
   returns `null` and the injected worker's `run` is **never called** (use a spy worker whose `run`
   sets a flag / throws if called).
4. **Orchestrator gate — forbidden:** a `topAction` with `forbidden: true` (even if `disposition`
   were somehow `"act"`) → `runWorker` returns `null`, worker never called.
5. **Happy path with injected MockWorker:** a `topAction` `{ kind: "fix_tests", disposition: "act",
   forbidden: false, ... }` → `runWorker(..., new MockWorker())` returns a `Proposal` with
   `status: "ok"`, non-empty `steps`, `backend === "mock"`, and `basedOn.topActionKind === "fix_tests"`,
   `basedOn.stateGeneratedAt === context.state.generatedAt`.
6. **Error path:** inject a worker whose `run` throws → `Proposal` with `status: "error"`,
   `error` set to the thrown message, `summary` starts with `"error:"`, `steps` `[]`.
7. **`writeProposal` persists atomically:** after `writeProposal(p)`, `proposalPath()` exists and
   parses back to an equal object, and `proposals/<id>.json` exists too.
8. **Pure helpers:** `parseCompletion("- do A\n- do B")` → `steps` `["do A", "do B"]` (bullets
   stripped), `summary === "do A"`; `parseCompletion("   ")` → `{ summary: "(empty completion)",
   steps: [], raw: "   " }`. `buildRequestBody(input, "m", 512)` → object with `model: "m"`,
   `max_tokens: 512`, `temperature: 0`, a top-level `system` string, and a 1-element `messages` array
   whose only entry is `{ role: "user", ... }` (Anthropic shape — NOT a `system` role message).
   `parseAnthropicResponse({ content: [{ type: "text", text: "hi" }] })` → `"hi"`;
   `parseAnthropicResponse({ content: [] })` throws.
9. **`createWorker` selects backend:** `createWorker({...worker: { backend: "mock" ... }})` returns a
   worker with `name === "mock"`; with `backend: "anthropic", model: "x"` returns
   `name === "anthropic:x"`. (Do NOT call `.run` on the anthropic one — no network in tests.)

All 45 existing tests must still pass. **No test may perform a network request.**

---

## 11. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes with zero errors (strict mode).
- [ ] `bun test` passes — all existing 45 tests plus the new Worker tests, **fully offline**.
- [ ] `bun run src/index.ts init` then `bun run src/index.ts work` on a **clean** state prints
      `"No actionable topAction ..."` and exits `0` (no `proposal.json` written, LLM never called).
- [ ] With a **failing-tests** state and `config.worker.backend` set to `"mock"`: `work` writes
      `proposal.json` with `status: "ok"`, non-empty `steps`, `action.kind === "fix_tests"`,
      correct `basedOn`; exits `0`.
- [ ] With a **blocked** (disposition `"ask"`) state: `work` prints the "nothing to do / ask" line and
      writes NO proposal.
- [ ] With `backend: "anthropic"` and `baseUrl` pointed at an unreachable host (e.g.
      `http://127.0.0.1:1` or a bogus domain): `work` still exits `0` and writes a `proposal.json` with
      `status: "error"` and a non-null `error` (the daemon/CLI never crashes on transport failure).
- [ ] `watch` with default config (`autoInvoke: false`) never calls the Worker (no "Worker:" line,
      no proposal churn from the loop).
- [ ] `.executive/proposal.json` and `.executive/proposals/` are gitignored (the whole `.executive/`
      tree already is — verify with `git check-ignore`).
- [ ] No out-of-scope behavior: the Worker performs no `git`, no shell/`spawn`/`exec`, no test run, no
      repo-file reads, no commits. (Grep `src/worker/` for `spawn`, `exec`, `child_process`, `git`,
      `readFileSync` of repo paths — expect none.)
- [ ] Only the files listed in §3 were created/edited (no changes to planner/state/events/watchers).

---

## 12. Deliverable

A commit containing the new `src/worker/` files and the three edits (`paths.ts`, `config.ts`,
`index.ts`), plus this doc left in place. Do NOT commit `.executive/` runtime data. When done, hand
back for review — Claude will run every item in §11 and will NOT trust the self-report.
