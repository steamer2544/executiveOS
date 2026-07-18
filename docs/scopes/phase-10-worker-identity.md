# Scope — Phase 10: Worker Identity (`.executive/claude.md`) (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.

---

## 0. What this phase is (and is NOT)

ExecutiveOS calls an LLM in exactly one place: the **Worker** (Phase 5), which turns one approved action
into a prose Proposal. Today the Worker's system prompt is a **fixed string hard-coded** in
`src/worker/anthropic.ts` (`buildSystemPrompt()`). There is no way for the owner to shape *who the Worker
is* — its priorities, tone, and standing instructions — without editing source.

**Phase 10 introduces `.executive/claude.md`: the product's Worker identity.** It is a short,
owner-editable Markdown file that becomes the **identity portion** of the Worker's system prompt. The
owner can now say "this is who you are and how you should think" without touching code.

**This is the artifact the vision doc deliberately deferred.** The vision doc (`read_it_my_bro.md`, Thai)
says *"อย่าเริ่มที่ claude.md"* — do NOT *start* here — because `claude.md` is only the Agent's
"personality and rules", **not the brain**. Starting there would have built the system *around* the LLM
(a chatbot), violating the core principle. The brain (Event Bus + State + Planner + Executor + Autopilot,
Phases 1–9) now exists, so adding the identity file is finally safe: it is a leaf that plugs into the
Worker, never the centre.

### Core principle (do not violate)

**The LLM is a reasoning engine (CPU) only — never the centre of the system.** `claude.md` is **advisory
input to the Worker's reasoning**. It shapes *how* the Worker proposes; it has **zero authority** over
*what* the OS decides to think about (the Planner), *whether* an action is allowed (the guardrails), or
*what gets executed* (the Executor). All of those stay in deterministic code and are **not overridable by
anything written in `claude.md`.**

### CRITICAL — hard guardrails (a violation of any is a defect)

- **`claude.md` cannot weaken any code-level guardrail.** The orchestrator's gate (`runWorker` returns
  null on `!topAction` / `forbidden` / `disposition !== "act"`), the Planner's `forbidden` flag
  (relationships/morality/large spending/life-goals), and the Executor's path-safety + isolated-branch
  rules all live in **code** and are untouched by this phase. No text in `claude.md` can disable them.
- **The operational contract is appended in CODE, after the identity, always.** The Worker's binding
  rules — "you PROPOSE concrete steps, you do NOT execute anything; keep output concise; short lines for
  steps" — must remain in `buildSystemPrompt` as a **fixed code string** that is concatenated **after**
  the identity text. A malformed or adversarial `claude.md` therefore can never remove the output
  contract; the contract has the last word in the prompt.
- **Bootstrap never overwrites an existing `claude.md`.** Like `config.json`, the default is written
  **only if the file is absent**. An owner's edits are never clobbered by `init`/`bootstrap`.
- **Blank/missing file → built-in default.** If `.executive/claude.md` is missing or blank (empty after
  `trim()`), the Worker falls back to the version-controlled `DEFAULT_IDENTITY` string. The Worker must
  never send an empty identity.
- **No behavioural change when the Worker isn't called.** This phase touches only the Worker's prompt
  assembly + bootstrap. The Planner, Executor, Synthesizer, Autopilot, and `watch` daemon logic are
  unchanged. With `backend: "mock"` nothing about identity matters (MockWorker ignores it) — all existing
  offline behaviour is identical.

### Out of scope (do NOT build)

- **No Synthesizer change.** `src/synth/*` is out of scope. The Synthesizer is a mechanical prose→JSON
  translator; injecting personality there risks corrupting its strict-JSON output. `claude.md` is the
  **Worker's** identity only. Do NOT touch `src/synth/anthropic.ts` or its system prompt.
- No change to `config.ts` (no new config block — the identity lives in a file, discovered by a fixed
  path, not configured). No change to the Planner, Executor, Autopilot, State, or the `watch` daemon.
- No new CLI command. (`init` already writes `.executive/` defaults; that is the only touch-point.)
- No LLM call in tests, no network, no live gateway. No reload-on-change/file-watching of `claude.md`
  (it is read fresh each time the Worker is constructed — good enough; a watcher is out of scope).
- No versioning/migration of `claude.md`. No multiple identities/profiles.

---

## 1. Data flow

```
init / bootstrap()
  └ if .executive/claude.md absent → write DEFAULT_IDENTITY   (idempotent, never overwrite)

runWorker(context, plan, config)                              (unchanged orchestrator)
  └ createWorker(config)                                       (factory)
        └ backend "mock"      → MockWorker           (identity irrelevant)
        └ backend "anthropic" → identity = loadWorkerIdentity()      ← NEW
                                new AnthropicWorker({ ..., identity })  ← NEW
  └ worker.run(input)
        └ AnthropicWorker: buildRequestBody(input, model, maxTokens, identity)  ← identity threaded in
              system = buildSystemPrompt(identity)
                     = <identity text from claude.md or default>
                       + "\n\n"
                       + <FIXED operational contract, in code>          ← always last
```

---

## 2. Tech + constraints

- Bun (latest), TypeScript (strict). No new runtime deps.
- Storage: `.executive/claude.md` (plain UTF-8 Markdown, gitignored with the rest of `.executive/`).
- Runs on Windows 11.
- **All tests OFFLINE**: identity loading is pure file I/O over a temp `EXECUTIVE_HOME`; prompt assembly
  is a pure string function. No network. A test that hits the network is a defect.
- User-facing strings: English for the prompt/identity (it is sent to the model). Code comments English.

### Existing functions/types you MUST know

- `execRoot()` in `src/paths.ts` (honours `EXECUTIVE_HOME`); you will add `claudeMdPath()` next to it.
- `bootstrap()` in `src/bootstrap.ts` — writes `.executive/` defaults idempotently (see its config.json /
  meta.json pattern; follow it exactly for claude.md).
- `buildSystemPrompt()`, `buildRequestBody(input, model, maxTokens)`, `AnthropicWorker` in
  `src/worker/anthropic.ts` — you will change these signatures to thread `identity` through.
- `createWorker(config)` in `src/worker/factory.ts` — loads the identity and passes it to AnthropicWorker.
- `MockWorker` in `src/worker/mock.ts` — **unchanged** (does not use identity).
- Existing tests in `src/worker/worker.test.ts` call `buildSystemPrompt()` / `buildRequestBody(...)`; you
  will update those call sites to the new signatures (this is the Worker's own test file — editing it is
  in scope).

---

## 3. Files to create / edit

### Create
```
src/worker/identity.ts        # DEFAULT_IDENTITY string + loadWorkerIdentity()
src/worker/identity.test.ts   # offline tests for loading + fallback
```

### Edit
- `src/paths.ts` — add `claudeMdPath()`.
- `src/bootstrap.ts` — write `.executive/claude.md` from `DEFAULT_IDENTITY` if absent (idempotent).
- `src/worker/anthropic.ts` — `buildSystemPrompt(identity)`, `buildRequestBody(input, model, maxTokens,
  identity)`, `AnthropicWorker` constructor gains `identity`, `run()` passes it to `buildRequestBody`.
- `src/worker/factory.ts` — for the anthropic backend, `loadWorkerIdentity()` and pass `identity` in.
- `src/worker/worker.test.ts` — update the existing `buildSystemPrompt` / `buildRequestBody` call sites
  and assertions to the new signatures; add an assertion that the system prompt contains the identity.

Do NOT edit any other file. In particular do NOT touch `src/config.ts`, `src/synth/*`,
`src/planner/*`, `src/executor/*`, `src/auto/*`, `src/state/*`, `src/index.ts`, or the `watch` daemon.

---

## 4. Paths (`src/paths.ts` — addition only)

```ts
/** Absolute path to .executive/claude.md (the Worker identity). */
export function claudeMdPath(): string {
  return execRoot() + "/claude.md";
}
```

---

## 5. Identity module (`src/worker/identity.ts`)

```ts
import { readFileSync } from "node:fs";
import { claudeMdPath } from "../paths.js";

/**
 * The version-controlled default Worker identity, written to .executive/claude.md
 * by bootstrap() when the file is absent, and used as the fallback when the file
 * is missing or blank. Short by design — it is an identity, not a long prompt.
 */
export const DEFAULT_IDENTITY = `# Identity

You are my executive function — the Worker (reasoning engine) of ExecutiveOS.

Primary objective: reduce my cognitive load so my attention stays free for design,
code, music, reading, and philosophy.

How you think:
- Observe → Understand → Plan → Act → Verify.
- Prefer autonomous, concrete action over explanation.
- Never ask for information that can be inferred from the repository, git history,
  terminal history, current state, or the event log. Inspect first.
- If your confidence is above 95%, act. Otherwise, ask.

What you never decide on your own (always defer to me):
- relationships, morality, large spending, or life-goal changes.

Keep every proposal inspectable and reversible.
`;

/**
 * Load the Worker identity: the contents of .executive/claude.md, or DEFAULT_IDENTITY
 * when that file is missing or blank. Pure read — no writes, no network.
 */
export function loadWorkerIdentity(): string {
  try {
    const raw = readFileSync(claudeMdPath(), "utf-8");
    return raw.trim().length > 0 ? raw : DEFAULT_IDENTITY;
  } catch {
    return DEFAULT_IDENTITY;
  }
}
```

Notes:
- Return the **raw** file (not trimmed) when non-blank, so the owner's formatting is preserved; only the
  blank check uses `trim()`.
- `loadWorkerIdentity` reads on every call; `createWorker` calls it once per Worker construction. That is
  intentional and cheap — no caching, no file watching.

---

## 6. Bootstrap (`src/bootstrap.ts` — addition, same idempotent pattern as config.json)

After the `config.json` write block, add:

```ts
import { DEFAULT_IDENTITY } from "./worker/identity.js";
import { claudeMdPath } from "./paths.js";
// ...
  // Write claude.md (Worker identity) only if it does not already exist.
  const idPath = claudeMdPath();
  if (!existsSync(idPath)) {
    writeFileSync(idPath, DEFAULT_IDENTITY);
  }
```

**Must remain idempotent:** running `bootstrap()` twice must not overwrite an edited `claude.md`. (Watch
for an import cycle: `bootstrap.ts` → `worker/identity.ts` → `paths.ts`. `identity.ts` imports only
`paths.ts` and `node:fs`, so there is no cycle. Do NOT import anything from `bootstrap.ts` into
`identity.ts`.)

---

## 7. Worker prompt assembly (`src/worker/anthropic.ts`)

Change `buildSystemPrompt` to take the identity and compose it with the **fixed operational contract**,
identity **first**, contract **last**:

```ts
/** The binding operational contract — fixed in code, always appended AFTER the identity. */
const OPERATIONAL_CONTRACT =
  "---\n" +
  "Operating rules (these always apply):\n" +
  "You are given ONE action to carry out and a compact context snapshot.\n" +
  "Propose concrete, actionable steps to carry out that action.\n" +
  "You do NOT execute anything — you only reason and write a proposal.\n" +
  "Keep your output concise. Use short lines for steps.";

/**
 * Compose the Worker system prompt: the owner's identity (from .executive/claude.md,
 * or the built-in default) followed by the fixed, non-overridable operational contract.
 */
export function buildSystemPrompt(identity: string): string {
  return identity.trim() + "\n\n" + OPERATIONAL_CONTRACT;
}
```

Thread `identity` through the request body:

```ts
export function buildRequestBody(
  input: WorkerInput,
  model: string,
  maxTokens: number,
  identity: string
): object {
  return {
    model,
    max_tokens: maxTokens,
    temperature: 0,
    system: buildSystemPrompt(identity),
    messages: [{ role: "user", content: buildUserMessage(input) }],
  };
}
```

`AnthropicWorker` gains an `identity` field:

```ts
export interface AnthropicWorkerOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  timeoutMs: number;
  identity: string;   // NEW — the composed identity text
}
```

Store it in the constructor and use it in `run()`:
`const body = buildRequestBody(input, this.model, this.maxTokens, this.identity);`

`buildUserMessage`, `parseAnthropicResponse`, `parseCompletion`, and the HTTP logic are **unchanged**.

---

## 8. Factory (`src/worker/factory.ts`)

Only the anthropic branch changes — load the identity and pass it in:

```ts
import { loadWorkerIdentity } from "./identity.js";
// ...
  // "anthropic"
  const apiKey = w.apiKeyEnv ? (process.env[w.apiKeyEnv] ?? "") : "";
  return new AnthropicWorker({
    baseUrl: w.baseUrl!,
    model: w.model!,
    apiKey,
    maxTokens: w.maxTokens!,
    timeoutMs: w.timeoutMs!,
    identity: loadWorkerIdentity(),
  });
```

The `mock` branch is unchanged.

---

## 9. Tests

### New — `src/worker/identity.test.ts` (offline)

Set `EXECUTIVE_HOME` to a fresh temp dir per test; clean up after. Cover at minimum:

1. **Missing file → default:** no `claude.md` on disk → `loadWorkerIdentity()` returns `DEFAULT_IDENTITY`.
2. **Present file → its contents:** write `.executive/claude.md` with custom text → `loadWorkerIdentity()`
   returns exactly that text (raw, untrimmed).
3. **Blank file → default:** write `"   \n"` → returns `DEFAULT_IDENTITY` (blank-after-trim fallback).
4. **Bootstrap writes default when absent:** call `bootstrap()` in a fresh `EXECUTIVE_HOME` → `claude.md`
   exists and equals `DEFAULT_IDENTITY`.
5. **Bootstrap never overwrites:** write a custom `claude.md`, call `bootstrap()` → the file is unchanged
   (owner edits preserved).

### Update — `src/worker/worker.test.ts`

- Update existing `buildSystemPrompt()` calls to `buildSystemPrompt(<some identity>)` and
  `buildRequestBody(input, model, maxTokens)` calls to include the new `identity` argument.
- Add assertions:
  - `buildSystemPrompt("MY IDENTITY")` **contains** `"MY IDENTITY"` **and** contains the operational
    contract text (e.g. `"do NOT execute"`), with the identity appearing **before** the contract.
  - The composed prompt still asserts the Worker-is-CPU framing survives (contract present regardless of
    identity — e.g. pass `identity: ""` and confirm the contract text is still present).

All existing tests must still pass (update call sites as needed — they are the Worker's own tests).
**No test may perform a network request.**

---

## 10. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes (strict).
- [ ] `bun test` passes — all existing tests (updated call sites) + new identity tests, offline.
- [ ] `init` on a fresh `.executive/` creates `.executive/claude.md` equal to `DEFAULT_IDENTITY`.
- [ ] Editing `.executive/claude.md` then running `init`/`bootstrap()` again leaves the edit intact
      (no overwrite).
- [ ] With a custom `.executive/claude.md`, the anthropic Worker's assembled system prompt **contains the
      custom identity text** followed by the fixed operational contract (verified via `buildRequestBody`
      /`buildSystemPrompt`, no network).
- [ ] A missing or blank `claude.md` yields `DEFAULT_IDENTITY` in the prompt (never an empty identity).
- [ ] The operational contract ("do NOT execute", concise steps) is present in the system prompt
      regardless of `claude.md` content (identity cannot remove it).
- [ ] `backend: "mock"` behaviour is byte-for-byte unchanged (MockWorker ignores identity); the whole
      existing offline suite is unaffected in behaviour.
- [ ] `src/synth/*`, `src/config.ts`, `src/planner/*`, `src/executor/*`, `src/auto/*`, `src/state/*`,
      `src/index.ts`, and the `watch` daemon are **unchanged** (git diff empty for those paths).
- [ ] `.executive/claude.md` is gitignored (whole `.executive/` tree already is); no runtime data
      committed.
- [ ] Only the files listed in §3 were created/edited.

---

## 11. Deliverable

A commit containing `src/worker/identity.ts`, `src/worker/identity.test.ts`, and the edits to
`src/paths.ts`, `src/bootstrap.ts`, `src/worker/anthropic.ts`, `src/worker/factory.ts`,
`src/worker/worker.test.ts`, plus this doc. Do NOT commit `.executive/` runtime data. When done, hand
back for review — Claude will run every item in §10 and will NOT trust the self-report.

---

## 12. Design notes (rationale — not extra work)

- **Why a file, not config:** the identity is prose the owner iterates on like a document, not a scalar
  setting. A gitignored `.executive/claude.md` (created from a version-controlled default) mirrors how
  `config.json` works and keeps the owner's private voice out of the repo while the *default* stays in
  source.
- **Why identity first, contract last:** the model reads the identity as "who I am", then the fixed
  contract as "the rules I operate under". Putting the code-owned contract last guarantees it is present
  and authoritative no matter what the editable identity says — the prompt-level mirror of the
  code-level guardrails.
- **Why the Worker only (not the Synthesizer):** the vision doc frames `claude.md` as the *Worker's*
  identity. The Synthesizer's job is a strict prose→JSON transform where personality is noise and a risk
  to output validity. Keeping identity out of synth preserves that determinism.
- **Why no file watching:** the Worker is constructed per `runWorker` call, so it always reads the
  current `claude.md`. An edit takes effect on the next Worker invocation with no daemon restart. A
  filesystem watcher would add moving parts for no real gain.
