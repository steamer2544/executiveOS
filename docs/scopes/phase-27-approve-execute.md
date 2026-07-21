# Scope — Phase 27: Approve → Execute (for code proposals) + Advisor life-domain proposals (ExecutiveOS)

> **Audience:** implementer (claude9arm) with NO prior context on this project. Everything you need is in this doc.
> **Author:** Claude (architect). **Reviewer/tester:** Claude. **You:** implement exactly this scope, nothing more.
> **Depends on:** Phase 26 (multi-repo) for per-repo targeting. If Phase 26 is not merged yet, `repo`
> targeting falls back to `process.cwd()` — the code must still work single-repo.

---

## 0. What this phase is (and is NOT)

The Advisor (Phase 22) shows the owner a **"Decisions for you"** queue of proactive proposals. Today,
clicking **Approve** only flips the proposal's `status` to `"approved"`, saves it, and logs a
notification — **it does not do the work.** The owner expected Approve to actually carry out the task.

**Phase 27 does two things:**

1. **Approve → Execute, for CODE proposals only.** A proposal the Advisor classifies as an executable
   code task gains, on approval, an actual run of the existing **Synth → Executor** pipeline: it
   synthesizes a `ChangeSet` from the proposal's action, validates it, and (when the owner has opted in)
   commits it to an **isolated `executive/change-<id>` branch** — reversible, never merged. Non-code
   proposals keep today's behavior (approve = record the decision).

2. **Advisor may now propose across ALL of life, not just "safe" work/health/admin.** The owner has
   decided that relationships / money / life-goals are *also* sources of decision fatigue and wants the
   Advisor to help think about them. So the Advisor prompt is broadened to propose in those domains too —
   **as suggestions for the owner to consider** — while a **hard code-level guardrail keeps those domains
   PROPOSE-ONLY**: they can never be marked executable, and approving one only records the decision.

**The owner's explicit boundary (do not violate):** *"Propose / help me think — fully, across everything.
But anything irreversible in the real world still waits for me to do it."* Execution is therefore limited
to **code changes on an isolated git branch** (inherently reversible via `git branch -D`, and never merged
by the system). The runtime has no hands for irreversible real-world actions and must not pretend to.

### CRITICAL — hard guardrails (a violation of any is a defect)

- **Only code proposals are ever executable.** `executable === true` is allowed **only** for a
  work/code-category proposal that targets a real repo. Any proposal in a sensitive domain
  (relationships, morality/ethics, large spending, major life-goals) MUST have `executable === false`,
  enforced by a **code filter** that runs regardless of what the LLM returns — never trust the model to
  self-police this.
- **Execution = isolated branch only, reversible, never merged.** Approving an executable proposal runs
  the **existing** `applyChangeSet` (Phase 6) which commits only to `executive/change-<id>` and returns
  HEAD to the original branch. The system NEVER merges, pushes, or touches the working branch history.
- **Apply is opt-in; dry-run is the default.** Approving an executable proposal always synthesizes +
  validates. It only *commits to a branch* when `config.advisor.applyOnApprove === true` (default
  **false**). With the default, Approve produces a reviewed dry-run `ChangeSet` the owner then applies via
  the existing `execute … --apply` flow. This preserves "every action inspectable and reversible".
- **Unsafe changeset never applied.** The LLM's synthesized ChangeSet passes through Phase 6
  `validateChangeSet` before the Executor sees it; an unsafe path (`..`-escape / absolute / `.git` /
  `.executive`) is rejected and never applied, not even in the branch.
- **Approving a non-executable proposal is exactly today's behavior:** status → approved, save, log
  notification. No synth, no git, no LLM.
- **No auto-approval.** Approval is always a human click (CLI or GUI). Nothing in this phase approves a
  proposal on its own.

### Out of scope (do NOT build)

- No merging / pushing / PR creation. No execution of anything but code-on-a-branch.
- No new LLM backend. Reuse the Advisor's existing backend + the Synth's existing Synthesizer.
- No autonomous run of approve→execute from the `watch` daemon (approval stays a human action).
- No change to the Planner / Worker / Autopilot. Executor and Synth get **additive** changes only.
- No external-service actions for life-domain proposals (email/LINE/calendar) — those remain records.

---

## 1. Proposal type changes (`src/advisor/types.ts` — additive)

Add optional fields to `Proposal` and `ProposalDraft`:

```ts
export interface Proposal {
  // ... existing fields unchanged ...
  executable?: boolean;   // true ONLY for a code task on a real repo (see guardrail). Default false.
  repo?: string;          // target repo NAME (matches State.repos[].name) for an executable proposal.
  files?: string[];       // optional file hints fed to the synthesizer.
  // execution outcome, set after an approve that executed:
  execution?: {
    ran: boolean;
    applied: boolean;         // true if it committed to a branch
    branch: string | null;    // executive/change-<id> when applied
    changeSetWritten: boolean;
    valid: boolean;           // validation result
    testPassed: boolean | null;
    message: string;          // short human summary
  };
}

export interface ProposalDraft {
  category: string;
  title: string;
  detail: string;
  action: string;
  executable?: boolean;   // model's suggestion; the code filter has final say
  repo?: string;
  files?: string[];
}
```

All additive/optional — an old `advisor.json` still loads, and a proposal without these behaves as
non-executable.

---

## 2. Advisor prompt + classification (`src/advisor/anthropic.ts`, `src/advisor/mock.ts`)

### 2a. Broaden the domains, keep execution honest (SYSTEM_PROMPT)

Rewrite `SYSTEM_PROMPT` so the Advisor:
- May propose across **work AND all of life — including relationships, money, and life-goals** — framed as
  *small suggestions for the owner to consider*, reversible where possible.
- Must set `"executable": true` **only** for a concrete **coding task** on the owner's codebase that it can
  describe as file changes, and then also give `"repo"` (the project/repo name) and optionally `"files"`.
- Must set `"executable": false` for everything else, and **especially** for anything about relationships,
  ethics/morality, large spending, or major life-goals — those are for the owner to act on, never the
  system.
- JSON shape now: `[{"category","title","detail","action","executable":bool,"repo"?:string,"files"?:string[]}]`.

Update `parseDrafts` to read the new optional fields (default `executable:false`, `repo`/`files` optional).

### 2b. The non-negotiable code filter (`src/advisor/advisor.ts` or `store.ts`)

When turning a `ProposalDraft` into a queued `Proposal`, apply a pure `sanitizeExecutable(draft): {executable, repo, files}`:

```
sensitive category if category (lowercased) matches any of:
  relationship, relationships, romance, family, friend, moral, morality, ethic, ethics,
  spend, spending, money, finance, financial, invest, purchase, buy, goal, "life goal", life-goal, career-change
executable := draft.executable === true
              AND NOT sensitive
              AND category (lowercased) is a work/code category (e.g. "work","code","dev","engineering","refactor","test","bug")
              AND draft.repo is a non-empty string
              AND draft.action is a non-empty string
if not executable → repo/files dropped (undefined)
```

This runs on **every** draft regardless of backend, so a jailbroken/confused model can never smuggle a
sensitive task into the executable path. Unit-test it directly (§6).

The MockAdvisor should emit at least one `executable:true` code draft (with a `repo`) and one
`executable:false` life draft, so offline tests exercise both paths.

---

## 3. Execution on approve (`src/advisor/execute.ts` — new; `src/advisor/advisor.ts` — edit)

### 3a. `runSynth` gains an instruction override (`src/synth/*` — additive)

Today `runSynth` loads the latest Worker `proposal.json` as the synthesis instruction. Add an optional
`instruction` to `SynthOptions`:

```ts
export interface SynthOptions {
  repoRoot: string;
  config: Config;
  explicitFiles?: string[];
  proposalId?: string | null;
  instruction?: string;        // NEW: when set, use THIS text as the synthesis instruction
                               // instead of loading proposal.json. Backward-compatible (absent = today).
  synthOverride?: Synthesizer;
}
```

When `instruction` is present, `runSynth` builds the `SynthInput` from it directly (no `proposal.json`
read), keeps every other step identical (file selection, synthesize, `validateChangeSet`, dry-run
`applyChangeSet`, write `changeset.json` + `synth-report.json`). Absent → **byte-identical to today**.

### 3b. `executeProposal(proposal, config, opts)` (`src/advisor/execute.ts`)

```ts
export async function executeProposal(
  p: Proposal,
  config: Config,
  opts?: { apply?: boolean; synthOverride?: Synthesizer }
): Promise<Proposal["execution"]>;
```

Steps:
1. If `p.executable !== true` → return `{ ran:false, applied:false, branch:null, changeSetWritten:false,
   valid:false, testPassed:null, message:"not executable — recorded only" }`. (Caller then does today's
   record-only path.)
2. Resolve the **target repo root**: from `config.watch.repos` find the entry whose `name === p.repo` and
   use its `path`; if none (or Phase 26 not present) fall back to `process.cwd()`. (Single-repo setups
   just use cwd.)
3. Call `runSynth({ repoRoot, config, instruction: p.action, explicitFiles: p.files, synthOverride })` —
   this synthesizes + **validates** + dry-runs and writes `changeset.json`.
4. If synth failed or validation is invalid → return `{ ran:true, applied:false, ..., valid:false,
   message:<why> }`. Do NOT apply.
5. If valid AND `opts.apply === true` → read `.executive/changeset.json` and call
   `applyChangeSet(cs, { apply:true, repoRoot, config })` (Phase 6 isolated branch). Capture branch +
   testPassed into the result. On any throw, catch → `applied:false` + message; never crash the caller.
6. If valid AND not applying → return `{ ran:true, applied:false, changeSetWritten:true, valid:true,
   message:"dry-run changeset ready — review then execute --apply" }`.

`executeProposal` must be **offline-testable** via `synthOverride` (a MockSynthesizer). The apply path
uses a temp git repo in tests.

### 3c. Wire it into `decideProposal` (`src/advisor/advisor.ts`)

Change `decideProposal(id, decision, edits)` so it can execute. Because execution is async, make the
executing path async (add `decideProposalAsync` OR make `decideProposal` async — pick one and update all
call sites; the CLI/GUI already `await` where needed). On **approve**:

- Apply the owner's edits (as today) and set status `"approved"`, save the store (as today).
- If the (edited) proposal is `executable === true`:
  - `const execResult = await executeProposal(p, config, { apply: config.advisor?.applyOnApprove === true });`
  - Store `p.execution = execResult`, save again.
  - Log a notification whose summary reflects the outcome (e.g. `"Approved + branched: <title>"` when
    applied, `"Approved (dry-run ready): <title>"` when not, `"Approved: <title>"` for non-executable).
- Else (non-executable): today's behavior exactly (record + notification), no synth/git.

`reject` is unchanged.

---

## 4. Config (`src/config.ts` — additive, backward-compatible)

Add one flag to the existing `advisor` block:

```ts
  advisor?: {
    enabled?: boolean;
    cooldownMs?: number;
    maxOpen?: number;
    applyOnApprove?: boolean; // if true, approving an EXECUTABLE proposal commits to an isolated branch
                              // immediately (still never merges). Default false → approve leaves a
                              // reviewed dry-run changeset for the owner to `execute --apply`.
  };
```

Default `false`; merge in `loadConfig()` like the other advisor fields. Backward compatible.

---

## 5. CLI + GUI

### CLI (`src/index.ts`)
- The existing `proposals` list should show an `[executable]` marker on executable proposals.
- Add an approve path if one is not already exposed, or extend the existing decision command, e.g.
  `approve <proposalId> [--apply] [--note "..."]` / `dismiss <proposalId>`. `--apply` on the CLI forces
  the apply path for that one approval even if `applyOnApprove` is false (explicit owner intent). Print the
  `execution` outcome (branch, valid, testPassed) after an executable approve.

### GUI (`src/ui/server.ts`, `src/ui/page.ts`)
- The "Decisions for you" cards already have Approve/Dismiss + editable action/note (Phase 22). For an
  **executable** proposal, the card shows a small badge (e.g. "⚙ will create a branch") and Approve routes
  through the executing path. After approval, the card shows the `execution` result (branch name / "dry-run
  ready" / "tests failed — parked on branch").
- For a **non-executable** proposal, Approve behaves as today (records) — label it so the owner knows it
  will not "do" anything (e.g. "records your decision").
- `/api/proposal/decide` must `await` the async decision and return the updated proposal incl.
  `execution`. Do not block the event loop; a slow synth is awaited on that request only.
- No new secret is exposed. No new whitelist entry beyond what already exists.

---

## 6. Tests (`bun test`, OFFLINE) — required

- `sanitizeExecutable`: a work/code draft with a repo → executable true; the same draft in a sensitive
  category (relationship/spending/goal/etc.) → executable **false** even if `draft.executable:true`; a
  code draft with no `repo` → false; each sensitive keyword covered.
- `runSynth` with `instruction`: given a MockSynthesizer, an `instruction` override produces a changeset
  without reading `proposal.json`; without `instruction` it still reads `proposal.json` (unchanged).
- `executeProposal`:
  - non-executable → `ran:false`, no synth called.
  - executable + MockSynthesizer producing a valid changeset, `apply:false` → `ran:true, applied:false,
    valid:true, changeSetWritten:true`.
  - executable + valid + `apply:true` in a **temp git repo** → commits to an `executive/change-*` branch,
    HEAD returns to the original branch, `applied:true, branch` set; the original branch history untouched.
  - executable + synthesizer returns an **unsafe** changeset (`../etc`) → validation fails → `applied:false,
    valid:false`, no branch.
- `decideProposal` (async): approving an executable proposal (mock synth) sets `p.execution`; approving a
  non-executable one behaves exactly as the existing Phase 22 test (record + notification, no execution);
  reject unchanged.
- MockAdvisor emits both an executable code draft and a non-executable life draft.
- Config: `advisor.applyOnApprove` defaults false and merges.

All existing tests (260, or 26x after Phase 26) must still pass. **No network. Git tests use a temp repo.**

---

## 7. Acceptance criteria (Claude will verify ALL of these by running them)

- [ ] `bun run typecheck` passes (strict); `bun test` passes offline.
- [ ] **Non-executable approve = record only** (today's behavior): approving a life/health proposal writes
      no changeset, spawns no branch, logs the approval. Verified live (mock advisor).
- [ ] **Executable approve, default config (`applyOnApprove:false`)** → synthesizes + validates a changeset
      (dry-run), writes `changeset.json`, creates **no** branch; the owner can then `execute … --apply`.
      Verified live in a temp git repo with the mock synthesizer.
- [ ] **Executable approve with `applyOnApprove:true` (or CLI `--apply`)** → commits to
      `executive/change-<id>`, returns HEAD to the original branch, original history untouched; `execution`
      records the branch. Verified live in a temp git repo.
- [ ] **Sensitive domain never executes:** a proposal whose category is relationship/spending/goal, even if
      the (mock) model marks `executable:true`, is stored `executable:false`; approving it records only.
- [ ] **Unsafe changeset never applied:** a synthesizer returning a `..`-escaping op → validation blocks it,
      no branch, even with `applyOnApprove:true`.
- [ ] **Advisor proposes broader domains:** the (broadened) prompt is present; live against the real 9arm
      gateway is optional (owner-run), but the offline MockAdvisor covers both a code and a life proposal.
- [ ] Planner / Worker / Autopilot **unchanged** (git diff empty). Synth + Executor changes are additive
      and their existing tests still pass; `runSynth` without `instruction` is byte-identical.
- [ ] `.executive/` stays gitignored; only the intended files were created/edited.

---

## 8. Files to create / edit

### Create
```
src/advisor/execute.ts        # executeProposal(...)
src/advisor/execute.test.ts   # offline + temp-git tests
```

### Edit
- `src/advisor/types.ts` — `executable`/`repo`/`files`/`execution` on Proposal + Draft.
- `src/advisor/anthropic.ts` — broadened SYSTEM_PROMPT + parse new fields.
- `src/advisor/mock.ts` — emit an executable code draft + a life draft.
- `src/advisor/advisor.ts` (or `store.ts`) — `sanitizeExecutable` on enqueue; async `decideProposal`
  wired to `executeProposal`.
- `src/synth/synth.ts` + `src/synth/types.ts` — optional `instruction` override (additive).
- `src/config.ts` — `advisor.applyOnApprove` + default + merge.
- `src/index.ts` — CLI approve/dismiss (+ `--apply`), `proposals` shows `[executable]`.
- `src/ui/server.ts` + `src/ui/page.ts` — executable badge, await async decide, show `execution` result.

Do NOT edit the Planner, Worker, or Autopilot.

---

## 9. Deliverable

A commit containing §8's files + this doc. Do NOT commit `.executive/` runtime data. Hand back for
review — Claude runs every item in §7 and will NOT trust the self-report.

---

## 10. Design notes (rationale — not extra work)

- **Why execution is code-on-a-branch only:** it is the one action the runtime can take that is fully
  reversible (`git branch -D`) and never touches shared history — it satisfies "every action inspectable
  and reversible" without giving the system hands in the real world. Everything else stays a proposal.
- **Why the code filter, not just the prompt:** the owner deliberately opened the Advisor to sensitive
  life domains. That makes it *more* important that a model slip can't route a "money" or "relationship"
  item into the executor. Prompt guidance is advisory; the `sanitizeExecutable` filter is the enforced
  guardrail, tested directly.
- **Why `applyOnApprove` defaults false:** the owner wants one-click execution, but defaulting to
  auto-commit would surprise every existing user on upgrade. Ship it off; the owner flips it on knowingly.
  Even on, it only ever writes an isolated branch the owner reviews and merges.
- **Why `instruction` on `runSynth` instead of a parallel synth:** the Advisor's `action` is already a
  concrete instruction; feeding it straight to the existing, tested Synth→validate→Executor pipeline reuses
  every guardrail rather than duplicating them.
