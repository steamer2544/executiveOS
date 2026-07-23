# Phase 36 — Make it speak first (proactive nudges over Discord)

## 1. Why this shape

Everything the runtime knows sits behind a page the owner has to remember to open. That is the
measured reason the system went unused — not quality, structure. Phase 35 gave it a mouth and hands
but still waits to be spoken to.

The substrate already exists. `runDigestTick` (`src/report/tick.ts`) knows the exact moment an item
**enters** the "Needs you" queue — that is what `notifications.jsonl` records. What is missing is
(a) a rule that decides whether *that* moment is worth interrupting for, and (b) a channel that
reaches the owner with the dashboard closed.

**Two hard constraints on the design:**

1. **One conversation, one brain.** A reply typed in Discord must enter the *same* `runTurn` and the
   *same* `.executive/conversation.jsonl` as the dashboard chat. Not a second assistant with its own
   memory. The confirm chip becomes Discord buttons carrying the same `pendingId` into `resumeTurn`.
2. **Rules pick the moment; the LLM only writes the sentence.** This is measured, not aesthetic: the
   Advisor queued the same decision four times because it has no memory across ticks (Phase 32); its
   hit rate was 61% with generic filler inside that (Phase 33); and a rule that *sounded* obvious —
   "frequent app switching means distraction" — died on contact with the log, because switching runs
   at p50 = 26 per 30 min, i.e. it is the owner's baseline (Phase 33). A model asked "should I
   interrupt now?" every tick would have fired on all of that.

## 2. Files

**Written by the architect BEFORE delegation** (they are the contract between the two jobs — do not
edit them):

| File | What |
|---|---|
| `src/channel/types.ts` | `Channel`, `OutboundMessage`, `InboundMessage` — the interface both jobs meet |
| `src/config.ts` | `config.agent.proactive` + `config.discord` blocks + defaults + merge |
| `src/paths.ts` | `nudgeLogPath()` → `.executive/nudges.jsonl` |

**Job A — proactive engine (channel-agnostic).** Touch ONLY these files:

| File | What |
|---|---|
| `src/proactive/types.ts` | `Nudge`, `NudgeRecord`, `ProactiveState` |
| `src/proactive/rules.ts` | **pure** — decides whether/what to nudge. No I/O, no LLM, no Date.now() |
| `src/proactive/log.ts` | `nudges.jsonl` append/read (mirrors `src/report/notify.ts`) |
| `src/proactive/compose.ts` | LLM writes the sentence, with a deterministic fallback |
| `src/proactive/proactive.ts` | `runProactiveTick` — glues the above to a `Channel` |
| `src/proactive/*.test.ts` | offline tests |

**Job B — Discord adapter.** Touch ONLY these files:

| File | What |
|---|---|
| `src/channel/discord.ts` | `createDiscordChannel()` — hand-rolled gateway + REST |
| `src/channel/discord.test.ts` | offline tests via injected WS/fetch seams |

**Job C — wiring (architect, after both):** `src/index.ts` only.

---

## 3. Job A — the proactive engine

### 3.1 `src/proactive/types.ts`

```ts
import type { NeedsYouItem } from "../report/types.js";

/** One thing worth interrupting the owner for. */
export interface Nudge {
  /** Stable dedup key. `${source}|${summary}` — the same keying notify.ts uses. */
  key: string;
  source: NeedsYouItem["source"];
  summary: string;
  detail?: string;
}

/** One line in .executive/nudges.jsonl. Append-only; never rewritten in place. */
export type NudgeRecord =
  | { event: "sent"; id: string; ts: string; key: string; source: string; summary: string; text: string; composedBy: "llm" | "fallback" }
  | { event: "answered"; id: string; ts: string }
  | { event: "suppressed"; ts: string; key: string; reason: string };

/** Carried by the caller across ticks (like DigestTickState). */
export interface ProactiveState {
  /** null = this process has never ticked. The first tick NEVER nudges (see §3.2). */
  firstTickDone: boolean;
  /** ms epoch of the last nudge actually sent, or null. */
  lastSentAt: number | null;
  /** id of the last sent nudge that has not been answered yet, or null. */
  awaitingReplyId: string | null;
}

export function createProactiveState(): ProactiveState { /* firstTickDone:false, … */ }
```

### 3.2 `src/proactive/rules.ts` — pure, and where the judgment lives

```ts
export interface NudgeDecisionInput {
  /** Items that ENTERED the needs-you queue this tick (DigestTickResult.added). */
  added: Nudge[];
  state: ProactiveState;
  /** Wall-clock, injected — the rules must be testable without mocking time. */
  now: Date;
  /** Records already in nudges.jsonl, oldest→newest. */
  history: NudgeRecord[];
  config: {
    enabled: boolean;
    maxPerDay: number;
    minGapMs: number;
    quietFrom: string; // "HH:MM"
    quietTo: string;   // "HH:MM"
  };
}

export type NudgeDecision =
  | { nudge: Nudge }
  | { nudge: null; reason: string };

export function decideNudge(input: NudgeDecisionInput): NudgeDecision;
```

Evaluate **in this order**, returning the first that applies. The `reason` string is what gets logged
as `suppressed`, so make it specific (`"quiet hours"`, `"daily budget spent (6)"`, …):

1. `!config.enabled` → `{ nudge: null, reason: "disabled" }`.
2. **`!state.firstTickDone`** → `{ nudge: null, reason: "first tick" }`.
   *Why this is not optional:* `DigestTickState` is per-process, so on every daemon restart
   `lastSignature` is `null` and **the entire existing queue looks "added"**. Without this rule,
   restarting `ui` fires a nudge storm. The caller sets `firstTickDone = true` after the first call.
3. `input.added.length === 0` → `{ nudge: null, reason: "nothing new" }`.
4. **Quiet hours** — `now`'s local `HH:MM` is inside `[quietFrom, quietTo)` → `reason: "quiet hours"`.
   The window **wraps midnight** (`"22:00"`–`"08:00"` is the default and must work). If
   `quietFrom === quietTo`, quiet hours are off.
5. **Min gap** — `state.lastSentAt !== null && now - lastSentAt < minGapMs` → `reason: "min gap"`.
6. **Daily budget** — count `event: "sent"` records in `history` whose `ts` falls on the same local
   calendar day as `now`; `>= maxPerDay` → `reason: "daily budget spent (N)"`.
7. **Repeat suppression** — pick the first item of `added` whose `key` has no `event: "sent"` record
   in the last 24h. If every candidate is a repeat → `reason: "already nudged"`.
   *(A resolved item that comes back tomorrow is allowed to nudge again — that is deliberate.)*
8. Otherwise → `{ nudge: <that item> }`. **At most one nudge per tick, ever.**

Also export, because they are the fiddly parts and must be tested directly:

```ts
export function inQuietHours(now: Date, from: string, to: string): boolean;
export function sentToday(history: NudgeRecord[], now: Date): number;
```

`rules.ts` must import **nothing** but `./types.js` and `../report/types.js`. No `node:fs`, no
`Date.now()`, no network.

### 3.3 `src/proactive/log.ts`

Mirror `src/report/notify.ts` exactly in style — it is the same problem solved once already.

```ts
export function appendNudgeRecords(records: NudgeRecord[]): void;
/** Defensive: missing file → [], corrupt line → skipped, never throws. */
export function readNudgeRecords(): NudgeRecord[];
```

Path comes from `nudgeLogPath()` in `src/paths.ts`. Create `execRoot()` if missing, as `notify.ts` does.

### 3.4 `src/proactive/compose.ts` — the LLM writes the sentence

```ts
export interface ComposedNudge { text: string; composedBy: "llm" | "fallback"; }
export async function composeNudge(nudge: Nudge, config: Config): Promise<ComposedNudge>;
```

- Build a one-shot call through `createChatBackend(config)` (`src/agent/protocol.ts`) with
  **`tools: []`** — this is writing a sentence, not doing work. Transcript: a single
  `{ kind: "user", text: <prompt> }`.
- Prompt requirements: give it the nudge `summary` + `detail`, and a compact line of context from
  `buildState().state` (currentTask, currentFile, branch). Ask for **one or two sentences, Thai,
  addressed to the owner, ending in a question they can answer with one line**. Forbid greetings,
  forbid restating the whole state, forbid inventing anything not in the input.
- **`fallback` is not an error path, it is a requirement.** Any throw, timeout, or empty text →
  return `{ text: <deterministic sentence built from the nudge>, composedBy: "fallback" }`. The
  gateway goes down regularly (524s) and a nudge that does not fire because the LLM was unreachable
  is the whole failure this phase exists to fix. `composeNudge` **never throws**.
- Deterministic fallback text: `` `${nudge.summary}${nudge.detail ? " — " + nudge.detail : ""}` ``.

### 3.5 `src/proactive/proactive.ts`

```ts
export interface ProactiveTickOptions {
  added: NeedsYouItem[];      // from DigestTickResult.added
  state: ProactiveState;      // advanced in place
  channel: Channel;
  config: Config;
  now?: Date;                 // default new Date(), injected in tests
}

export interface ProactiveTickResult {
  sent: { id: string; text: string; composedBy: "llm" | "fallback" } | null;
  /** Why nothing was sent. null when something was. */
  skipped: string | null;
}

export async function runProactiveTick(opts: ProactiveTickOptions): Promise<ProactiveTickResult>;
```

Flow:
1. `decideNudge(...)` with `history = readNudgeRecords()`.
2. No nudge → set `state.firstTickDone = true`, log a `suppressed` record **only** when the reason is
   a budget/quiet/gap/repeat suppression (**not** for `"disabled"`, `"first tick"` or `"nothing new"`
   — those fire every 30s and would flood the log), and return.
3. `composeNudge(...)`.
4. **Append the nudge to the conversation as an assistant message**
   (`appendMessage({ role: "assistant", text })` from `src/agent/session.ts`) *before* sending. This
   is what makes it one conversation: when the owner replies in Discord, `runTurn` reconstructs a
   transcript in which the assistant genuinely said this.
5. `await channel.send({ text })`. On `{ ok: false }`: do **not** append a `sent` record, return
   `{ sent: null, skipped: "channel: <error>" }`, and do not advance `lastSentAt` — an undelivered
   nudge must not spend the daily budget.
6. On success: append the `sent` record, set `state.lastSentAt`, `state.awaitingReplyId = id`,
   `state.firstTickDone = true`.

And the outcome half of the measurement:

```ts
/** Call when the owner sends ANY message (Discord or dashboard). Marks the open nudge answered. */
export function markNudgeAnswered(state: ProactiveState): void;
```
Appends `{ event: "answered", id, ts }` and clears `state.awaitingReplyId`. No-op when null.
This is the only reason the log exists: after two weeks, `sent` vs `answered` per source is the
evidence for whether the rules chose good moments.

### 3.6 Job A tests (`src/proactive/*.test.ts`)

All offline, no network, no real `Channel`. Use a `FakeChannel` recording `send` calls.

- `inQuietHours` — inside, outside, exact `from` boundary (inside), exact `to` boundary (outside),
  a **wrapping** window `22:00`–`08:00` tested at 23:30 and 02:00 and 12:00, and `from === to` → off.
- `decideNudge` — one test per suppression reason, in order, each proving the *earlier* rules did not
  fire it. Plus: first tick never nudges even with items; second tick with the same items does.
- `sentToday` counts only `sent`, only today, ignores `answered`/`suppressed`.
- Repeat suppression: same key twice → second suppressed; same key 25h apart → allowed.
- `readNudgeRecords` — missing file → `[]`; a corrupt line is skipped, surrounding lines survive.
- `composeNudge` — with a backend stub that throws → `composedBy: "fallback"` and text contains the
  summary; with a stub returning text → `composedBy: "llm"`. (Inject the backend; do **not** hit a
  network.)
- `runProactiveTick` — happy path sends exactly one message, appends exactly one `sent` record, and
  appends one assistant message to the conversation; a channel returning `{ok:false}` appends **no**
  `sent` record and leaves `lastSentAt` unchanged; two ticks in a row send at most one message.

---

## 4. Job B — the Discord adapter

Implement `Channel` (from `src/channel/types.ts`) against Discord's HTTP + Gateway API **by hand**.
This project has **zero runtime dependencies** and keeps it that way — the CLI, event bus and LLM
clients are all hand-rolled. Do not add `discord.js` or any package.

```ts
export interface DiscordChannelOptions {
  token: string;
  /** Discord user id allowed to talk to the bot. Anything else is ignored. */
  ownerId: string;
  /** Injected in tests. Default: globalThis.WebSocket / globalThis.fetch. */
  wsFactory?: (url: string) => WebSocketLike;
  fetchImpl?: typeof fetch;
}
export function createDiscordChannel(opts: DiscordChannelOptions): Channel;
```

### 4.1 Gateway (receive)

- `start()` opens `wss://gateway.discord.gg/?v=10&encoding=json`.
- On `op: 10` (HELLO) → start a heartbeat `setInterval` sending `{op:1,d:lastSeq}` every
  `d.heartbeat_interval` ms, and send IDENTIFY:
  ```json
  {"op":2,"d":{"token":"<token>","intents":4096,
   "properties":{"os":"windows","browser":"executiveos","device":"executiveos"}}}
  ```
  `4096` = `DIRECT_MESSAGES` (1<<12). **DMs to a bot always include message content**, so the
  privileged `MESSAGE_CONTENT` intent is deliberately NOT requested — the owner does not have to
  enable anything in the Developer Portal.
- Track `s` from every payload as `lastSeq`.
- `t: "MESSAGE_CREATE"` → if `d.author.id !== ownerId` **ignore it silently** (see §4.4); else call
  the handler with `{ kind: "text", text: d.content }`.
- `t: "INTERACTION_CREATE"` with `d.data.custom_id` matching `` `confirm:<pendingId>:<decision>` `` →
  1. immediately `POST /interactions/{d.id}/{d.token}/callback` with `{"type":6}`
     (DEFERRED_UPDATE_MESSAGE) so Discord does not show "interaction failed" — it has a **3-second**
     deadline, and running the tool takes far longer;
  2. then call the handler with `{ kind: "confirm", pendingId, decision }`.
  Reject the interaction if `d.member?.user?.id ?? d.user?.id` is not `ownerId`.
- On close/error → reconnect with a fixed 5s delay, clearing the heartbeat first. A plain reconnect
  (fresh IDENTIFY) is enough; do **not** implement RESUME — the cost is not worth it for a personal
  nudge bot, and a missed message during a 5s window is acceptable.
- `stop()` clears the heartbeat, closes the socket, and prevents the reconnect timer from firing.
  It must be idempotent.

### 4.2 REST (send)

- Lazily resolve the DM channel: `POST /api/v10/users/@me/channels` with
  `{ "recipient_id": ownerId }` → `id`. Cache it in memory for the process lifetime.
- `send({ text, confirm })` → `POST /api/v10/channels/{dmId}/messages` with
  `Authorization: Bot <token>`.
  - Without `confirm`: `{ "content": text }`.
  - With `confirm`: add one action row of three buttons —
    `ทำเลย` (style 1, `custom_id: "confirm:<id>:run"`),
    `ไว้ใจ tool นี้ตลอด` (style 2, `"confirm:<id>:trust"`),
    `ไม่` (style 4, `"confirm:<id>:no"`).
  - Discord's content limit is 2000 chars — **truncate to 1900 + `" …"`** rather than letting the
    API 400.
- `send` **never throws**: any non-2xx or network error → `{ ok: false, error: "<status>: <snippet>" }`.
  Every caller in Job A treats that as "not delivered", so silent failure is not an option.

### 4.3 Tests (`src/channel/discord.test.ts`, offline)

Drive a fake `WebSocketLike` (a small class with `send`, `close`, and settable `onmessage`/`onclose`)
and a fake `fetchImpl` recording requests. Assert:

- HELLO → IDENTIFY is sent with `intents: 4096` and the token; a heartbeat is sent after the interval.
- `MESSAGE_CREATE` from `ownerId` → handler receives `{kind:"text"}`.
- **`MESSAGE_CREATE` from a different author id → handler is NOT called.** This one is a security
  boundary, not a nicety (§4.4).
- `INTERACTION_CREATE` → the callback POST happens **before** the handler is invoked, and the parsed
  `{pendingId, decision}` is correct; a malformed `custom_id` is ignored.
- `INTERACTION_CREATE` from a non-owner id → handler NOT called.
- `send` posts to the DM channel, creating it on first use and reusing the cached id on the second.
- `send` with `confirm` includes three buttons with the exact `custom_id`s.
- `send` with a 3000-char text truncates to ≤ 2000.
- A non-2xx response → `{ ok: false }`, no throw.
- `stop()` twice does not throw and stops the heartbeat.

### 4.4 Why the owner check is a hard guardrail

The agent this channel feeds has **write tools**: it emits events, decides advisor proposals, and can
put a code change on a branch in the owner's repos. Anyone on Discord can DM a bot. `ownerId` is
therefore the authentication boundary for a machine, and it must be enforced in the adapter — not in
the wiring, not "later". A message from an unknown id is dropped without a reply (a reply confirms
the bot is live and invites probing).

---

## 5. Config (architect writes this; both jobs read it)

```ts
/** Proactive nudges — the runtime speaks first. OFF by default. */
agent.proactive?: {
  enabled?: boolean;   // default false
  maxPerDay?: number;  // default 6
  minGapMs?: number;   // default 1800000 (30 min)
  quietFrom?: string;  // default "22:00"
  quietTo?: string;    // default "08:00"
};

/** Discord channel. OFF by default. The token lives ONLY in .env. */
discord?: {
  enabled?: boolean;  // default false
  tokenEnv?: string;  // default "EXECUTIVE_DISCORD_TOKEN" — the env var NAME, never the token
  ownerId?: string | null; // default null → the channel refuses to start
};
```

Backward-compatible merge, same pattern as every other block. `config.json` **never** holds the
token; `.env.example` gains an `EXECUTIVE_DISCORD_TOKEN=` line.

---

## 6. What is NOT in scope

- **`trigger: "rules+llm"`.** The handoff floats it as a dial. It stays unbuilt until the `rules`
  baseline has been measured — `nudges.jsonl` (`sent` vs `answered`) is what settles whether the
  rules pick good moments, and adding a second, unmeasured source of nudges now would make that
  measurement uninterpretable. Do not add the config field.
- **Voice on Discord.** Text only. The dashboard already does two-way voice well (hold-Space in,
  `speechSynthesis` out); joining a voice channel and streaming audio is a large amount of machinery
  for reach we already have.
- **Slash commands, embeds, threads, reactions, presence, RESUME, sharding, rate-limit backoff.**
  One DM channel, plain content, three buttons.
- **Any change to** `src/report/tick.ts`, `src/agent/*`, `src/planner/*`, `src/state/*`,
  `src/advisor/*`, `src/executor/*`, `src/synth/*`. `runProactiveTick` consumes
  `DigestTickResult.added`; it does not reshape the thing producing it. Job A appends to the
  conversation through the existing `appendMessage` export and calls `createChatBackend` — it does
  not modify either file.
- **Email/Slack/push.** One channel. `Channel` exists so a second one is possible later, not so a
  second one ships now.

---

## 7. Acceptance criteria — run every one for real

Both jobs:

1. `bun run typecheck` clean (strict).
2. `bun test` — all pre-existing tests still pass, plus the new ones. Report the total.
3. No new entry in `package.json` dependencies.
4. `grep -rn "EXECUTIVE_DISCORD_TOKEN\|Bot " src/` shows the token read only from
   `process.env[...]` — never a literal, never written to a file.

Job A specifically:

5. First tick with 3 added items sends **nothing** (`skipped: "first tick"`); the second tick with
   the same items sends exactly **one** message.
6. With `quietFrom: "22:00", quietTo: "08:00"` and `now = 23:30`, nothing is sent; at `09:00` it is.
7. With `maxPerDay: 1` and one `sent` record already in today's log, the next tick is suppressed with
   a reason naming the budget.
8. A `Channel` whose `send` returns `{ ok: false }` leaves `nudges.jsonl` with **no** `sent` record
   and `state.lastSentAt` unchanged — verified by asserting both, not by reading the code.
9. A `composeNudge` backend that throws still produces a nudge, with `composedBy: "fallback"` and the
   summary inside the text.
10. After a successful tick, `readConversation()` ends with an `assistant` message equal to the sent
    text.

Job B specifically:

11. A `MESSAGE_CREATE` payload whose `author.id` is not `ownerId` invokes the handler **zero** times.
12. An `INTERACTION_CREATE` produces the deferred callback POST *before* the handler runs.
13. `send` with a 3000-char string posts a `content` of length ≤ 2000.

**Sabotage check (required, and report the result):** after everything is green, break each of these
one at a time, run `bun test`, confirm it **fails**, then restore:
- delete the `firstTickDone` guard in `decideNudge` → the first-tick test must fail;
- make `inQuietHours` ignore the midnight wrap → the 23:30 test must fail;
- remove the `author.id !== ownerId` check → the non-owner test must fail.
A test that passes against broken code is worse than no test. If one of these still passes, the test
is vacuous — fix the test, and say so in your report.

---

## 8. Notes for the implementer

- Write in the existing style: file-top comment saying *why*, `//` comments only where the reason is
  not obvious from the code, no classes where a closure does, no abstraction used once.
- Read the neighbouring file before writing yours: `src/report/notify.ts` for the JSONL log,
  `src/report/tick.ts` for the tick shape, `src/agent/protocol.ts` for the backend call. Match them.
- Edit files in place with targeted edits. Do **not** rewrite a whole file through a generated
  script — it has flattened non-ASCII characters in this repo before.
- Thai strings appear in user-facing text. Keep them exactly as written here; do not "fix" them.
- If something in this spec is ambiguous or looks wrong, say so in your report instead of guessing.
