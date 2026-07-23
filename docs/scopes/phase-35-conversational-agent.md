# Phase 35 — Jarvis: talk to it, and it does the work

> **Goal:** replace "open the dashboard and read cards" with "say what you want, it does it."
> Voice or text, Thai or English. It answers from real runtime data, and it can actually act.

## 1. Why this shape

The system is good and unused, because it is **pull**: everything it knows is behind a page the owner
has to remember to open, and everything it produces is a suggestion the owner still has to carry out.

An earlier draft of this phase split "talking" from "doing" into two phases. That was wrong — a chat
that can only answer is something the owner tries twice and abandons, exactly like the dashboard. The
deliverable is **one thing that talks and has hands.**

Design target: **the owner should never have to type, navigate, or remember a command.** Hold a key,
say it, tap yes once. Anything that costs more than that will not get used.

## 2. Three things that stay (they are what make laziness safe)

Not ceremony — each one is load-bearing for "I can let it rip without watching it":

1. **Writes land on an isolated `executive/change-<id>` branch, never the working branch.** Reuses the
   Phase 6 Executor unchanged. Bad result → `git branch -D`, nothing lost.
2. **A write tool asks once before it runs — and can be trusted permanently after that.** Per-tool
   "ไว้ใจแล้ว" allow-list persisted in config, so the tap is a one-time cost per tool, not per call.
   Path safety and the branch rule still apply to a trusted tool; trust removes the *prompt*, not the
   *guardrail*.
3. **The agent may not assert anything about the owner's work without reading it first.** No memory of
   facts; every claim comes from a tool call against `State` / the event log / the repo. Without this
   it produces confident, plausible, wrong answers — the failure mode the owner cannot detect.

Everything else from the previous draft (phase splits, principle essays) is dropped.

## 3. Files

```
src/agent/
├── types.ts      # AgentTool, ToolResult, ChatMessage, PendingWrite
├── tools.ts      # registry: read tools + write tools, dispatch, path safety
├── protocol.ts   # native tool_use  |  json-fence fallback  (§6)
├── loop.ts       # agentic loop: call → tools → call → … → answer
├── session.ts    # conversation.jsonl + context assembly + trimming
└── *.test.ts
src/ui/server.ts  # + /api/chat, /api/chat/history, /api/chat/confirm, /api/chat/clear
src/ui/page.ts    # + chat panel (mic + TTS + confirm chips)
src/config.ts     # + `agent` block (backward-compatible, absent = off)
src/paths.ts      # + conversationPath()
src/index.ts      # + `chat [message]` CLI
scripts/probe-tools.ts   # committed gateway capability probe (§6)
```

## 4. Tools

**Read (always auto-run, no prompt):**

| name | args | returns |
|---|---|---|
| `get_state` | — | current `State`, **pre-formatted** (durations as words, local timestamps), incl. `patterns` + `repos` |
| `get_digest` | — | rendered digest incl. "Needs you" + suggestions |
| `tail_events` | `{n?, source?}` | last n events (default 20, cap 100), seq order |
| `read_file` | `{path}` | file contents, path-safety validated, capped at `config.synth.maxFileBytes` |
| `grep` | `{pattern, glob?}` | `file:line` hits, cap 100 |
| `git_log` | `{n?, repo?}` | recent commits of a configured repo |
| `git_status` | `{repo?}` | porcelain status |
| `list_proposals` | `{status?}` | the Advisor queue |
| `list_notifications` | `{n?}` | recent "Needs you" transitions |

**Write (confirm once, then trustable):**

| name | args | does |
|---|---|---|
| `emit_event` | `{source, type, data}` | append an event — whitelisted to the same types `/api/emit` allows (`system.blocked`/`unblocked`/`task`/`test_result`/`note`) |
| `edit_files` | `{title, instruction, files?}` | build a `ChangeSet` via the **existing Synth**, validate it, and apply it through the **existing Executor** onto `executive/change-<id>` |
| `run_command` | `{cmd, repo?}` | run a shell command in a configured repo and return stdout/stderr/exit code |
| `approve_proposal` / `dismiss_proposal` | `{id, note?}` | decide an Advisor proposal (reuses `decideProposal`) |

Every tool reuses existing code (`buildState`, `buildDigest`, `read`, `runSynth`, `applyChangeSet`,
`decideProposal`, …). **No new derivation, git, or LLM logic lives in `src/agent/`.**

**Formatting rule:** never hand the model raw milliseconds or epochs — it read `sessionMs: 2173707` as
"36 hours" when it is 36 *minutes*, systematically (Phase 33.1). Tool output carries units in words.

## 5. Guardrails, stated as code requirements

- `read_file` / `grep` / `run_command` / `edit_files` are confined to `config.watch.repos[].path` +
  cwd, and reject `..` escape / absolute paths / drive letters / `.git` / `.executive`. A rejected
  path returns `{ok:false, error}` to the model — it must **never throw into the loop**.
- `edit_files` **cannot bypass validation**: the ChangeSet goes through `validateChangeSet` before the
  Executor sees it, even dry-run. LLM output is untrusted (Phase 7 rule, unchanged).
- `run_command` is a **write** tool (it can do anything), so it needs confirmation, and trusting it is
  a deliberate choice the owner makes knowingly. Time-capped; output truncated before the model sees it.
- Iteration cap `maxToolRounds` (default 8), then the loop must produce a text answer — never spiral.
- Every user message, tool call, tool result and reply is appended to `.executive/conversation.jsonl`,
  so the whole chain is inspectable afterwards.
- System prompt = `loadWorkerIdentity()` (Phase 10 `.executive/claude.md`) + a fixed in-code
  `AGENT_CONTRACT` appended **last**, so editing `claude.md` changes personality, never rules.

## 6. Tool-call protocol — two implementations, chosen by probe

**Unknown at scope time:** whether the 9arm gateway passes Anthropic `tools` through to Qwen. The probe
returned **HTTP 524 on every request, including a 1-word prompt with no tools** — Arm's inference box is
down (`HANDOFF.md` §4), so this is unmeasured, not negative. `scripts/probe-tools.ts` is committed; run
it when the box is back.

`protocol.ts` exposes one interface, two impls:
- **`native`** — real `tools` in the request, `tool_use` blocks back, results as `tool_result`.
- **`json`** — tools rendered into the system prompt; model replies with a fenced
  ```json {"tool": "...", "args": {…}}```; results fed back as a user message. Reuses the fence-tolerant
  extraction already used by `parseGuesses` / `parseDrafts`.

`config.agent.toolProtocol: "auto" | "native" | "json"` (default `"auto"`: try native, fall back to json
on a 4xx naming `tools`, remember for the process lifetime). **Both paths must pass the same tests
against a mock backend**, so the phase is not blocked on the gateway.

## 7. Config (`config.agent`, absent = off)

```jsonc
"agent": {
  "enabled": false,
  "toolProtocol": "auto",
  "maxToolRounds": 8,
  "historyTurns": 20,
  "speak": false,               // browser TTS for replies
  "trustedTools": [],           // write tools the owner has said "ไว้ใจแล้ว" to
  "commandTimeoutMs": 60000
}
```

Backend/model/key/tokens/timeout reuse `config.worker` + `llmMaxTokens` / `llmTimeoutMs` — **no new
gateway, no new token.** Floor `llmMaxTokens(config, 8192)`: the Advisor hit `stop_reason: max_tokens`
at 4096 on 3/3 live runs once its prompt got stricter (Phase 33.1), and an agent prompt carrying tool
schemas is strictly longer.

## 8. UI — optimised for not typing

- **Chat panel** in the existing dashboard. Hold-to-talk already exists (Phase 23.2) — it posts the
  transcript to `/api/chat` instead of `system.note`. Replies optionally spoken via the browser's
  `speechSynthesis` (zero deps, has Thai voices; silent no-op when unavailable).
- **Confirmation is one tap, inline in the chat**: "จะแก้ 3 ไฟล์ใน myshi — [ทำเลย] [ไว้ใจ tool นี้ตลอด] [ไม่]".
  "ไว้ใจตลอด" appends to `config.agent.trustedTools` via a whitelisted atomic update, like
  `updateAutonomyConfig`.
- Tool calls render as a collapsed one-liner (`🔧 get_state`) so the owner can see *why* it said something.
- Routes: `POST /api/chat` `{message, via}`, `GET /api/chat/history?n=`, `POST /api/chat/confirm`
  `{pendingId, decision}`, `POST /api/chat/clear` (archives, never deletes).
- **Timeouts:** `idleTimeout` derives from `llmTimeoutMs` (Phase 34.2), but a turn with 8 tool rounds can
  outlive it — so `/api/chat` streams/chunks, or caps total wall-clock below `idleTimeout` and returns a
  partial answer rather than a dead request.
- **CLI:** `bun run src/index.ts chat "<message>"` — one turn, prints reply + tool trace. Needed for
  testing without a browser.

## 9. Not in scope

- **It never speaks first.** `runDigestTick` untouched; proactive nudges + an external push channel
  (Telegram/LINE/email) are the next phase — that is what finally ends "ไม่ได้ใช้", but it is useless
  before there is something to answer *to*.
- **No auto-merge.** Applied changes sit on `executive/change-*`; the owner merges.
- **No changes to planner / worker / executor / synth / advisor / state-builder logic** (calling them is
  fine; a behavioural diff in those dirs is not).
- No new LLM backend or token. No replacing the existing dashboard cards.

## 10. Acceptance criteria (run every one for real)

1. `bun run typecheck` + `bun test` green; new tests offline via a mock backend.
2. `config.agent` absent → config still merges, chat off, dashboard renders as today.
3. **Both protocols, same test body:** a mock returning one tool call for `get_state` then a text answer
   yields a reply containing a real field from a fixture `state.json`, and `conversation.jsonl` holds
   `user` → `tool` → `assistant`.
4. **Iteration cap:** a mock that always asks for a tool terminates after `maxToolRounds` with a text
   answer and exactly `maxToolRounds` tool messages logged.
5. **Path safety:** `read_file` with `../../etc/passwd`, `C:\Windows\win.ini`, `.git/config`,
   `.executive/config.json` each return `{ok:false}` **without throwing**; a real repo file reads.
6. **Confirmation:** an untrusted write tool does **not** run — it returns a pending action; after
   `/api/chat/confirm` it runs; with the tool in `trustedTools` it runs immediately. Asserted per tool.
7. **`edit_files` end-to-end in a temp git repo:** produces a commit on `executive/change-*`, HEAD
   returns to the original branch, working tree clean. An unsafe changeset (`../../etc/passwd`) is
   blocked by validation and creates **no branch**.
8. **Units:** `get_state` output for a 36-minute session contains "minute", not a bare `2173707`.
9. **Server:** `POST /api/chat` over a real localhost port replies with the mock backend; history
   returns the turn; `agent.enabled: false` refuses.
10. **CLI:** `chat "ตอนนี้ทำอะไรอยู่"` prints a reply + tool trace.
11. **Sabotage check** (`GOTCHA.md` §4): break (a) path confinement, (b) the iteration cap, (c) the
    confirmation gate — independently. Each must turn a test red. Restore.
12. **Live, when the gateway returns:** run `scripts/probe-tools.ts`, record the verdict in `GOTCHA.md`
    §1, then hold a real Thai conversation and confirm answers match `state.json` — and that a real
    `edit_files` request lands a reviewable branch.
