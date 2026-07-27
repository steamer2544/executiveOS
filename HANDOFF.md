# ExecutiveOS — Handoff & Plan

> **Purpose:** a single doc to resume this project cold if context/memory is lost. Pairs with
> `CLAUDE.md` (the authoritative phase-by-phase log), `GOTCHA.md` (traps & non-obvious failure modes —
> read before touching PowerShell/state/tests/LLM), and `README.md` (user-facing overview).
> Last updated after the **Phase 40 session** (SQLite event storage + the live flip to it, a destroyed-config
> incident + guardrail, and an agent budget-ladder fix), on top of a live-hardening session on the Discord
> agent (think-loop fix + retry resilience + message chunking + button feedback + session trust), **Phase 39
> + 39.1** (state decay/TTL; deadline decay as an opt-in dashboard toggle), **Phase 38** (sandbox
> `run_command`), and **Phase 36 LIVE** (Discord). **876 passing tests** + two opt-in browser e2e, all green.
> Everything through Phase 41 is **pushed** (`origin/main` = `main`). The agent is
> **live-confirmed working** end-to-end over Discord. **If a running bot misbehaves after a pull, RESTART
> it — code isn't hot-reloaded.**
>
> **▶️ LATEST SESSION (Phase 41, 5 commits `090d42d`→`e37ead0`, all PUSHED): "make me a file" now works.**
> The agent writes complete, playable HTML games into a folder the owner names. Read the Phase 41 entry
> in `CLAUDE.md` for the full account; the load-bearing facts:
> - **The gateway kills every request at ~125 s and Qwen runs at 33–48 tok/s ⇒ ~4,000 output tokens is a
>   PHYSICAL ceiling.** Raising `max_tokens` past that is a no-op — the response cannot come back.
>   Streaming does not help (only two SSE chunks arrive, then the socket idles through the think).
>   The old `BUDGET_LADDER` (16384/32768) was asking for impossibilities and is gone.
> - **A spiral is near-deterministic per context, not a per-roll dice throw** (0/7, 0/3, 0/3 on the same
>   transcripts; 3/3 and 4/4 on short ones). The fix is `CONTEXT_LADDER = [null,3,1]` — shrink the
>   history, never the ceiling.
> - **A large file cannot be generated in one call** (a Tetris page is still truncated at 6144 tokens).
>   `save_file` has `append`; `maxToolRounds` is 20 because writing needs rounds that looking-up does not.
> - **`run_command` had never worked for the owner** — `sh -c` does not exist on Windows, and it only
>   "passed" in testing because that ran from Git Bash. It now uses a temp `.bat` (Bun escapes inner
>   quotes on Windows, so `cmd /c` silently answered about the wrong path).
> - **New `save_file` tool**: `dir` argument, per-folder approval button (📁, remembered in
>   `agent.fileOutput.dirs`), a 🌿 branch option when the destination is inside a git repo, and four
>   guardrails (confined dirs / no executables / no overwrite / NEVER_TRUSTABLE).
> - **Owner-verified live for BOTH pong and tetris** (tetris confirmed by the owner over Discord after
>   restarting the bot — "มันทำได้ดีเลยว่ะ"). **A running bot must be RESTARTED after any pull** — all of
>   this is source, and only `config.json` is hot-reloaded.
> - **Known model-quality limits (not bugs to chase):** tool selection is not deterministic (one run
>   reached for `run_command` instead of `save_file`; one claimed success with `tools: (none)`), and a
>   hard prompt can take 100–340 s.
> - **`agent.fileOutput.allowExecutable` and `allowOverwrite` are `true` in the owner's runtime config
>   ON PURPOSE — the owner turned them on.** Do not "fix" them back to the source defaults. It means
>   the agent may write `.bat`/`.ps1`/`.exe` into an approved folder and may replace an existing file
>   there, so a save into those folders is not automatically reversible. (They were briefly suspected
>   of being another config-corruption incident; a canary — md5 the real `config.json`, run the full
>   suite, md5 again — cleared the test suite, and the owner confirmed it was them.)
> - **Incident worth remembering:** an auto-approving *test harness* (the architect's, not the product)
>   let the agent run `git stash` + commit and sweep ~2 h of uncommitted work; recovered with
>   `git stash pop`. The Phase-38 denylist behaved correctly — `git reset --hard` was refused; `git stash`
>   is deliberately "ask", and the harness answered for the human. **Never auto-approve confirms in a
>   live-test harness**, and check `git stash list` before assuming work is lost.
>
> **🔴 READ FIRST — the owner's `.executive/config.json` was DESTROYED during an earlier session and rebuilt from
> evidence.** Something running inside the repo wrote a **4-key test fixture** over the real config, wiping
> every setting (Discord `ownerId`, `agent.repoSearchRoots`, screen-OCR engine, autonomy toggles). It was
> not the committed test suite — a canary run of the full suite left the file byte-identical — and the most
> likely culprit is a throwaway/intermediate test written by a delegated `claude-9arm` run that resolved
> `execRoot()` while `EXECUTIVE_HOME` was unset. It is **not recoverable** (gitignored, no copy on disk, no
> trace in any log). The current config was **reconstructed from artifacts that could only exist if a
> setting had been on** (e.g. `screen-inferred.json` written at 14:19 ⇒ `screen.ocr.enabled`), plus the
> `ownerId` the owner re-supplied. **Blocks NOT reconstructed** (they were left at defaults — turn them
> back on if they were yours): `capture`, `transcribe` beyond `webspeech`, and any `watch.repos` multi-repo
> list. `.env` was never touched. **Guardrail added (`4af108e`):** `execRoot()` now **throws** under
> `NODE_ENV=test` when `EXECUTIVE_HOME` is unset, so this mistake is a red test instead of silent data
> loss. It immediately caught two pre-existing offenders — `planner.test.ts` (ceremony call) and
> `ocr.test.ts` (had been writing scratch `.ps1` files into the owner's live `.executive/tmp` on every
> run). **There is still no backup of `.executive/config.json` anywhere; consider adding one.**
>
> **✅ Phase 36 is LIVE.** The owner supplied a bot token + `ownerId`, ran `ui`, and the bot **DM-answered
> from real state** (asked "ตอนนี้ผมทำอะไรอยู่" → correct project/task/branch/file). What remains is the
> **measurement**: leave it running ~2 weeks and read `.executive/nudges.jsonl` — `sent` vs `answered` per
> source is the whole point. **Do NOT add `agent.proactive.trigger: "rules+llm"` until that baseline
> exists** (deliberately cut from Phase 36): a second, unmeasured nudge source makes the ratio
> uninterpretable. **Setup notes from the live bring-up:** `config.discord.tokenEnv` is the ENV VAR NAME
> (`EXECUTIVE_DISCORD_TOKEN`) not the token (`process.env[tokenEnv]`); the token lives only in `.env`. The
> bot must **share a guild** with the owner to DM them (OAuth2 `bot`-scope invite). Discord "Application
> Test Mode" / URL-origin (localhost vs discord proxy) / Interactions Endpoint URL are Activities settings
> — irrelevant here, leave blank. Run `ui` **alone** (running `watch` too opens a SECOND channel + nudge
> runner + watchers + Advisor/infer triggers on the same token → doubled everything). Known designed
> behavior: the engine nudges on items that *enter* the queue while the daemon runs; a backlog item
> present at startup is suppressed by the first-tick guard (avoids a restart nudge-storm).
>
> **✅ Phase 37 highlights** (this session): the dashboard chat renders **markdown** and no longer yanks
> the scroll on its 5s refresh; the agent can look at **any repo by name** (discovered under
> `config.agent.repoSearchRoots`, no registration — the owner set `source/repos` + `Programming`) via a
> new `list_repos` tool + a `repo` arg on `read_file`/`grep`; a **secrets gate** now blocks the agent from
> reading `.env`/keys/`.ssh` in any repo (found by /scrutinize — discovery had widened `read_file` to 16
> repos and `.env` was readable). New opt-in browser test `bun run test:e2e:chat`. See CLAUDE.md Phase 37
> + GOTCHA §8 (the `page.ts` template-literal backslash trap that e2e caught). **`config.agent.repoSearchRoots`
> defaults to `[]` (discovery off)** — it is set in the owner's runtime config, not in source defaults.

> **🚀 The repo is now PUBLIC on GitHub** — `https://github.com/steamer2544/executiveOS` (`origin/main`),
> MIT licensed. History was secret-scanned clean before the first push (`.env`/`.executive` never tracked;
> the only token-shaped hits are fake fixtures in `agent.test.ts`). **Anything committed from here is
> world-visible** — keep secrets in `.env` (gitignored) as always, and secret-scan again before any push
> that touched config/fixtures: `git grep -nE "MTUz|sk-|xox[baprs]-|-----BEGIN|Bearer [A-Za-z0-9._-]{20}"
> $(git rev-list --all)` (expect only the two `agent.test.ts` fixtures).
>
> **▶️ NEXT UP — the planned roadmap is EMPTY** (Phase 40 was the last promised item; Phase 41 and 42
> came from live failures and live data, not a list). Nothing is pending.
>
> **▶️ PHASE 42 (this session) — read the nudge log, found two defects, fixed both.** Details in the
> `CLAUDE.md` Phase 42 entry; the load-bearing facts:
> - **The nudge sentence was built from an internal dedup key.** `digest.ts` sets
>   `summary = "Planner needs your call: " + a.kind` and `detail = a.reason` (the human sentence), and
>   `compose.ts` sent the *summary* as the task. The model reads "needs your call" as a **telephone
>   call** — 2 of 4 live nudges told the owner to phone a code module. Fixed in the presentation layer
>   (`nudgeSubject`): **`summary` never reaches the model when a detail exists.**
> - **Do NOT "fix" this in `digest.ts`.** `summary` is the dedup key (`key = source|summary`, plus
>   `needsYouSignature` / `notify.ts`). Rewording it invalidates every key already written to
>   `nudges.jsonl` + `notifications.jsonl` → repeat-suppression sees everything as new → a nudge burst.
> - **The `answered` signal is now readable**, which is what the `rules+llm` dial was waiting on:
>   `answered` carries `latencyMs`, a new `expired` record carries `ageMs`, and
>   `ANSWER_WINDOW_MS = 30 min` splits them. `openNudgeId` treats **both** as closing (without that, an
>   expired nudge stays open forever and every later message appends a duplicate).
> - **The old "5/5 = 100% answered" was not a measurement** — real latencies were 51 s / 2.4 min /
>   8 min / 43 min / 1 h 55 min, and the last two are the owner happening to chat later. **The baseline
>   restarts from here.** Records written before this phase have no `latencyMs`; treat them as unusable
>   for the ratio, not as 100%.
> - **A delegated run reported "all 18 criteria implemented", all green — and had shipped a live bug**
>   that its own test could not see (the criterion-4 test asserted on the prompt's *first line*, so an
>   instruction line naming the forbidden identifiers put them right back into the prompt). Two of the
>   new tests were repaired; a 5th sabotage was added to prove the repair bites. **Review the tests, not
>   just the code — a green suite proves nothing about a test that never looked.**
>
> **The open measurement is now the RATIO ITSELF**: leave `ui` running and read `nudges.jsonl` —
> `answered` (with latency) vs `expired` vs `suppressed`, per source. That still gates the deferred
> `agent.proactive.trigger: "rules+llm"` dial; do not add a second nudge source before it exists.
>
> **✅ Phase 40 shipped AND the runtime is now RUNNING ON SQLITE** (this is a change from what the previous
> handoff said — the flip happened at the end of the session). `bun:sqlite`, no new dependency, one
> `events` table with `seq INTEGER PRIMARY KEY` (unique, indexed, never renumbered on delete, so `compact`
> keeps its guarantee). `append`/`read`/`tail` kept their exact signatures so **no caller changed**;
> `readSync`/`tailSync` were *added* for the synchronous State Builder. **`seq` allocation deliberately did
> NOT move** — `seq.ts`/`meta.json` stay authoritative for both backends, which is what makes flipping back
> and forth coherent.
>
> **Live state after the flip:** `config.storage.backend = "sqlite"`; `events.db` holds **7,040 rows,
> seq 1→7512** (the gaps are old `compact` deletions, correctly preserved); the five `.jsonl` files are
> **frozen and md5-identical to pre-switch** — they are the backup, and nothing writes to them any more.
> Verified live after the flip: `tail`, `build-state`, `report`, `emit`, and a real `ui` run (which printed
> `Discord: connected` and a digest tick) all work from the database alone.
>
> **To roll back to JSONL:** set `"storage": { "backend": "jsonl" }` and restart. **Caveat that matters:**
> every event appended *since* the flip lives **only** in `events.db`, so a rollback silently loses them
> unless you export first. There is no db→jsonl exporter — `migrate-events` is one-way. Don't ping-pong.
>
> **The next thing should come from measurement, not a list.** The two cheap candidates already waiting are
> §6's Candidate A (surface `State.patterns` in the digest/dashboard) and Candidate B (derive the Tesseract
> OCR language from the window title). The bigger unfinished business is still **reading `nudges.jsonl`**
> (sent vs answered per source) after Phase 36 has run a couple of weeks — that measurement gates the
> `rules+llm` nudge dial.
>
> **🔴 SUPERSEDED — the budget ladder described two paragraphs below was REMOVED.** A later session
> measured the thing neither earlier session checked: **the gateway kills every request at ~125 s**
> (Cloudflare, 6 observations 125.0–128.2 s) and the model runs at **33–48 tok/s**, so **~4,000 output
> tokens is the physical ceiling** — the ladder's 16384/32768 rungs asked for responses that *can never
> come back*, and even the 8192 base was over the wall. Streaming does not help (the gateway emits no
> thinking tokens, so the socket is idle and the proxy cuts it anyway). The "4/4 at 32768" reading below
> was a misinterpretation: those rolls just didn't spiral. Also disproved: the spiral is **near-
> deterministic per context** (0/7, 0/3, 0/3 on the same transcripts) — not an independent per-roll risk —
> while shrinking the context answered 3/3 and 4/4. **The ceiling ladder is now a CONTEXT ladder**
> (`WALL_SAFE_MAX_TOKENS`/`WALL_SAFE_TIMEOUT_MS` clamps + `ContextTooHeavyError` + `CONTEXT_LADDER =
> [null, 3, 1]`). See CLAUDE.md "Agent context ladder" and GOTCHA §1. Keep reading below only for the
> history of how the wrong conclusion was reached.
>
> **Agent budget ladder (this session, `/debug-mantra`) — a SECOND, different `max_tokens` failure.** The
> bot answered *"เป็นยังไงบ้าง"* correctly from real state, then failed *"คุณสร้างโปรแกรมเครื่องคิดเลข
> ง่ายๆ ไว้บนเดสทอปผมได้ไหม"* with *"used its entire token budget thinking"*. **This is NOT the
> temperature-0 think-loop below** — that was a true non-terminating loop where 40k did not help; here the
> thinking terminates, it just needs more room than the 8192 floor. **Both are true; don't use one to
> dismiss the other.** Measured by looping the identical prompt with the conversation reset each run:
> **1/8 answered at 8192, 4/4 at 32768**, and a `[DBG]` probe showed every failing run burning
> `output_tokens` **exactly 8192 on all four attempts** — which disproves the old code's premise that
> "each roll is independent … re-sampling 3× drives 25% → 0.4%". Four fresh rolls, four identical
> exhaustions. (The ~25% was measured on a *meta-question*: **the loop rate is prompt-dependent** — this
> class of open-ended agentic ask is ~93% per call. Never generalise one prompt's rate.) Calls that DO
> answer cost only **937–2,775** output tokens, so a flat 32768 would tax every normal turn. Fix:
> **`BUDGET_LADDER = [1,2,4,4]`** — the payload is rebuilt per attempt so a retry *raises the ceiling*
> instead of re-rolling at the same one, capped at 4× so a genuine loop still ends the turn.
> **Live-verified 6/6** at the owner's own config vs 1/8 before. **Known cost: the hard prompt takes
> ~190–290 s** (it fails at 8192 first, then succeeds a rung up). If that becomes the complaint, the lever
> is the **21,493 input tokens** (system prompt + 15 tool schemas + 20 history turns), NOT the ceiling.
> See CLAUDE.md "Agent budget ladder" + GOTCHA §1.
>
> **Agent chat resilience (this session, `/debug-mantra`):** the Discord bot answered "สวัสดี" with
> **"ขอโทษครับ พัง: The operation was aborted."** — diagnosed live as a **transient gateway latency spike
> >120s** (the exact same message replayed against the real transcript answered in 6.7s; probing also
> **proved the gateway supports native `tools`** — 200/~1s with all 15 schemas). Fixed on our side:
> `AnthropicChatBackend.step()` now **retries once** on a transient abort/timeout/network/5xx (NOT a 4xx —
> the tools-downgrade needs it), and `chatErrorMessage()` gives an honest Thai message in both front doors
> instead of the raw exception. 720 tests. See CLAUDE.md "Agent chat resilience" + GOTCHA §7.
>
> **Agent think-loop fix (this session, `/debug-mantra`):** a second live Discord failure — *"…the model
> used its entire token budget thinking … (stop_reason: max_tokens)"* to "planner คืออะไร". Debugged by
> isolation: raising `max_tokens` to 40k didn't help, a fresh transcript didn't help; **plain system +
> tools → normal tool_use in 3s, but the agent system prompt tips Qwen into an infinite `<think>` loop.**
> Root cause: the agent hardcoded **`temperature: 0`** (greedy decoding), which Qwen's docs say causes
> "endless repetitions." Fix: `step()` now sends **temp 0.6 + top_p 0.95 + top_k 20** (Qwen's recommended
> sampling — but even so a stress test measured the real loop rate at **~25%**, so sampling alone is NOT
> enough), plus **`SAMPLE_MAX=4` — re-sample an empty `max_tokens` up to 3×** (~25% → ~0.4%), and retry an
> unparseable body. `max_tokens` kept at 8192 (lowering it truncates hard questions into failure). Rare
> multi-loop tail up to ~300s but it never fails now. **`/no_think` / `enable_thinking:false` are ignored
> by the gateway.** Other backends still use temp 0 — switch them if they ever loop. See CLAUDE.md "Agent
> think-loop fix" + GOTCHA §1. **LIVE-CONFIRMED working:** the owner analyzed opm-be + opm-fe end-to-end.
>
> **Discord UX fixes + session trust (this session, live owner feedback — all LIVE-CONFIRMED):**
> - **Long replies were truncated at Discord's 2000-char limit** (answer cut mid-word while the dashboard
>   had it whole) → `chunkContent()` splits a reply into ≤2000-char messages (newline-preferring), buttons
>   ride the last chunk. `truncateContent` deleted.
> - **A tapped confirm button lingered with no feedback** (bare `type:6` ack) → the callback is now a
>   **`type:7` UPDATE_MESSAGE** that edits the confirm message in place: strips buttons + stamps the choice
>   (`✅`/`🤝`/`❌`).
> - **Owner didn't want to confirm every command** (agent runs `Get-ChildItem`, `git diff`, … each a
>   separate tap) → Phase 38 keeps run_command/edit_files **never persistently trustable**, so the owner
>   chose a **session-scoped** trust: a **"ไว้ใจทั้งแชทนี้"** button trusts a tool for the rest of the
>   conversation only, **resets on clear**. New `agent-session-trust.json` store; `isTrusted` checks it
>   first (covers the NEVER_TRUSTABLE tools, bounded); new `ConfirmDecision "trust_session"`. **Guardrail
>   held:** the run_command **denylist still hard-refuses destructive commands even when session-trusted**
>   (check is inside `run_command.run()`; session trust only skips the *confirm*). See CLAUDE.md "Discord
>   UX fixes" + "Session trust". 736 tests.
>
> **⚠️ Every code fix above needs a bot RESTART to take effect** — `temperature`, the retry, chunking, the
> buttons all live in source (loaded once at process start); only `config.json` is hot-reloaded. The owner
> kept seeing the think-loop error for a while precisely because the running `ui` had the old code. After
> any agent/channel/server code change: stop `ui`, `git pull`, restart. (GOTCHA §1 has this too.)
>
> **Known non-bug:** Qwen occasionally garbles Thai spelling in its own output (`ปจจุบัน`, `ผ่่านมา`) — a
> model tokenization artifact, not our code; still readable, left as-is.
>
> **Recently shipped this session (all pushed):**
> - **Phase 38 — sandbox `run_command`** — `classifyCommand` → deny/allow/ask; a **denylist in code**
>   (rm -rf, curl|sh, sudo, git push --force, …) hard-refuses in `run_command.run()` even after confirm;
>   `NEVER_TRUSTABLE = {run_command, edit_files}` makes standing trust inert. See CLAUDE.md Phase 38.
> - **Phase 39 — state decay/TTL** — `buildState` ages out **only manually-asserted** signals (auto-sensed
>   never decay): `BLOCKED_TTL_MS`=24h, `MANUAL_TASK_TTL_MS`=72h (task/project → branch/repo inference).
>   Measured against the builder's own `now` (pure); uncertain (bad `ts`) → keep; Planner untouched.
> - **Phase 39.1 — opt-in deadline decay** — `/scrutinize` caught that unconditional deadline decay reverses
>   Phase 32's "close it out" nag (a deadline is a commitment, not transient state), so it is **OPT-IN +
>   DEFAULT OFF**: a dashboard **Autonomy** toggle backed by `config.state.deadlineDecayDays` (null/≤0 = off;
>   positive N = retire a deadline >N days past due; toggle writes 7). See CLAUDE.md Phase 39 + 39.1.
>
> **Deferred nits (not bugs, don't forget):** Phase 37's /scrutinize — `discoverRepos` re-scans the
> filesystem on every unknown-repo tool call (no cache); same-basename repos across two search roots resolve
> to the first silently. Phase 39 — the `blocked`/`task` TTLs are constants, not config (promote to a
> dashboard toggle like deadline decay if the owner wants to tune them).

> **Design record (built in Phase 36, kept for the reasoning):** Discord is **text-first, voice
> deferred** — the dashboard already does two-way voice locally (hold-Space in, `speechSynthesis` out),
> so Discord's job is *reach*, not richness. A Discord reply enters the **same** `runTurn`/
> `conversation.jsonl` as the dashboard (one brain, not a second assistant); the confirm chip became
> Discord buttons carrying the same `pendingId`. **Who decides when to speak: rules pick the moment, the
> LLM only writes the sentence** — measured, not principled: the Advisor queued the same decision 4× with
> no cross-tick memory (P32); an "app-switch = distraction" rule died at p50 = **26 per 30 min**, the
> owner's baseline not an anomaly (P33). An LLM asked "interrupt now?" every tick fires on all of it. The
> `rules+llm` dial was **deliberately cut** until the `rules` baseline is read from `nudges.jsonl`.
>
> **⚠️ Phase 35/36 left one thing unmeasured: does the gateway support native tool calling?** Every
> probe returned **524 — including a 1-word prompt with no tools** — so Arm's box was down and this is
> unmeasured, not negative. Run `bun scripts/probe-tools.ts` from the repo root when the box is back and
> record the verdict in `GOTCHA.md` §1. Both protocols are implemented and tested and `auto` downgrades
> on a 4xx naming `tools`, so nothing is blocked either way.
>
> **Two smaller candidates, both cheap:**
> **(a) Derive the Tesseract OCR language list from the Layer 1 window title** — `-l tha+eng`
> hallucinates Thai on English-only screens (measured — `GOTCHA.md` §2), and the window title already
> carries real Thai (it is `GetWindowTextW`, not OCR), so Thai-in-title → `tha+eng`, else `eng`.
> **(b) Feed `State.patterns` to the digest/dashboard** — Phase 33 computes them and the Planner uses
> them, but the owner cannot see the numbers a proposal cites without reading `state.json`.
>
> **Phase 34.2 added a second method: re-review the phase you just shipped, cold.** Reading 34.1 as an
> outsider — not as its author — found that it had hardened **1 of 17** identical call sites, that its
> three new tests **all passed against the un-fixed code**, that the timeout it set equalled the client
> timeout it was meant to outlive, and that its own `GOTCHA.md` entry described a bug that never
> happened (`git log -S` proved it). None of that is visible from the diff; all of it is visible from
> the call graph and `git log`. Budget one pass for it.
>
> **Phase 33 set the method for anything new: read the real event log and calibrate before writing a
> rule.** Doing that killed two rules that sounded obvious (app-switch thrash is p50=**26**/30min — the
> *baseline*, not an anomaly; repo switches are p99=**0** because only one repo is ever tagged), and
> proved a proposed 3-hour session threshold would have **never fired** (longest real session: 1.87h).
> **Layer 3 (vision) is a dead end on this gateway:** the team is allow-listed to `qwen3.6-35b-a3b`, so
> `qwen-vl-max` returns 403. It fails cleanly; Layer 2 is the path that works (and keeps the image local).
> **If the gateway starts timing out (524):** check Arm's inference box — the LiteLLM proxy reports
> `Cannot connect to host vllm.tetra-magellanic.ts.net:8000` when it is down. Nothing to fix on our side.
>
> **If every LLM feature suddenly reports "nothing found":** check whether the work **Zscaler** proxy is
> on — it MITMs TLS and Bun's `fetch` rejects the re-signed cert, and every client swallows that into a
> polite empty result. `GOTCHA.md` §1 has the diagnosis. Not a product bug.

---

## 1. What this is

An **event-driven personal "Chief of Staff" runtime** (not a chatbot). It observes the owner's activity,
derives a compact state, decides the highest-value next action with rules, and — behind explicit approval —
acts on an isolated git branch. It has grown into a proactive assistant that **proposes** work + life
actions for the owner to approve/reject, and can **listen to the owner's own dictated notes**.

**Core principle (never violate):** the LLM is a reasoning engine (CPU) **only**, never the centre. Most
of the system is deterministic rule-based code; the LLM is a "Worker" called only when reasoning is needed.
Main loop: **Observe → Understand → Predict → Act → Observe again.**

**Owner:** Thai; cannot read Chinese — respond in Thai or English only.

---

## 2. Current status — DONE through Phase 40 (the planned roadmap is complete)

The full loop works and is validated (including **live against the real LLM gateway**). Phases (see
`CLAUDE.md` for the detailed entry on each — it is the authoritative log; this table is a map):

| # | Phase | What it added |
|---|-------|---------------|
| 1 | Runtime skeleton | JSONL EventStore, CLI, config, bootstrap |
| 2 | EventBus + Watchers | git + fs watchers, `watch` daemon |
| 3 | State Builder | `state.json` / `context.json` (rule-based) |
| 4 | Planner | ranked actions + `act`/`ask` guardrail → `plan.json` |
| 5 | LLM Worker | first LLM use; action → prose Proposal (proposes, never executes) |
| 6 | Executor | applies a ChangeSet on an isolated `executive/change-*` branch |
| 7 | Synthesizer | Proposal → ChangeSet (validated before Executor) |
| 8 | Autopilot | `auto` chains plan→work→synth→execute (manual) |
| 9 | Continuous Autopilot | `auto` in the `watch` daemon behind 2 default-off gates + dedup/cooldown |
| 10 | Worker Identity | `.executive/claude.md` editable persona (can't weaken code guardrails) |
| 11 | Digest / Report | `report` → human-readable `digest.md` incl. **"Needs you"** queue |
| 12 | Watch Digest | daemon refreshes digest + alerts only on "Needs you" change |
| 13 | Full ask-queue | "Needs you" surfaces every `ask` action, not just the top |
| 14 | Notification log | durable `notifications.jsonl` of "Needs you" transitions |
| 15 | Auto-task | infer `currentTask` from git branch name |
| 16 | Auto-project | infer `currentProject` from git repo (watcher tags `repo`) |
| 17 | Auto test results | `install-hooks` → post-commit hook emits pass/fail |
| 18 | Local web GUI | `ui` → `Bun.serve` dashboard on 127.0.0.1 |
| 19 | LLM inference | guess block/deadline (suggestions only, toggle) → `inferred.json` |
| 20 | **max_tokens headroom fix** | reasoning models "think" → 1024 truncated; floor 4096 / 120s. **Fixed a latent bug** in Worker+Synth (never caught: mock-only tests). + `init` writes `.gitignore`. |
| 21 | GUI polish | Confirm buttons for suggestions; `ui` also runs watchers |
| 22 | **Proactive Advisor** | proposes work+life actions → `advisor.json` queue; GUI "Decisions for you" cards (Approve/Dismiss/edit); `propose`/`proposals` CLI; daemon toggle |
| 23 | Voice/text capture | `capture <note>` CLI + dashboard push-to-talk (own-voice, **visible**) → `system.note` feeds the Advisor |
| 23.1 | Thai/English toggle | language selector for the mic |
| 23.2 | Hold-to-talk | hold Space to dictate in the dashboard |
| 24 | Whisper transcription | `config.transcribe` block; `POST /api/transcribe` server-side proxy to Whisper endpoint; MediaRecorder dashboard mic with Web-Speech fallback; scaffolded, needs owner's endpoint+key |
| 25 | Transcription backends + Settings | `transcribe.mode` = **webspeech / whisper-api / browser-wasm**; dashboard Settings card (mode + fields + Groq/local presets + Save + Download); `POST /api/settings`, `/api/transcribe/download`+`/status`, static `/vendor`+`/models`; `download-model` CLI; browser-wasm serves lib+model from 127.0.0.1 (audio never leaves the machine) |
| 25.1–25.4 | browser-wasm polish | minimal-dtype model download (~81MB not ~1.6GB); Playwright e2e proves the in-browser transcription end-to-end; single merged language selector |
| 26 (+26.1) | **Multi-repo watching** | `config.watch.repos[]` → one git(+fs) watcher per repo via `buildWatchers`; State picks `activeRepo` (highest-seq repo-tagged event) + `state.repos[]`; Project/Branch/Task move together. 26.1: sort `repos` by seq (deterministic), not wall-clock |
| 27 | **Approve → Execute** | approving an **executable code** Advisor proposal (`executable:true`+`repo`) runs Synth→Executor onto an isolated branch (opt-in `applyOnApprove`/`--apply`); a hard `sanitizeExecutable()` filter forces life/money/relationship/goal proposals to record-only. Advisor prompt broadened to all of life; `approve`/`dismiss` CLI |
| — | FsWatcher temp-file fix | `isIgnoredPath()` now ignores dotfiles/dot-dirs + `.tmp.` infix + temp/backup suffixes (temp scratch was polluting `currentFile`) |
| 28 | **Screen-sense Layer 1** | poll-based watcher emits `screen.window{title,app}` on change (5th event source, no LLM/image); `State.currentWindow`, digest "Looking at" line. `CharSet.Unicode`+UTF-8 so Thai titles survive |
| 29 | **Screen-sense Layer 2 + 3** | screenshot → **on-device OCR** (Layer 2) or **`qwen-vl-max` vision** (Layer 3, OpenAI `/v1/chat/completions`) → **suggestions only** in `screen-inferred.json`, merged into the digest. Off by default |
| 30 | **State coherence** | `currentFile` pruned to files that still exist on disk (resolves against watched roots); empty `system.task` now **clears** the task; dashboard "Clear task" button |
| 29.1 | **Layer 2 goes live** | the Defender exclusion let the capture script actually run, exposing 2 defects it had masked: `Save()` needs an `ImageCodecInfo` (not `ImageFormat`) so **no file was ever written**, and WinRT rejects mixed-separator paths. Real screenshot → real OCR → real suggestions, end to end |
| 29.2 | **Failure honesty** | `runScreenInference` no longer breaks its "never throws" contract on the vision path (it left `screen-inferred.json` **stale**), and a hard LLM failure (TLS/401/403/timeout) now reports `ocr: llm unavailable — <reason>` instead of the indistinguishable `ocr: no signal`. Verdict on Layer 3: **`qwen-vl-max` is 403 on this gateway** |
| 31 | **Tesseract OCR engine** | `config.screen.ocr.engine` = `winrt` (default) \| `tesseract` + `languages` + `tesseractPath`; `normalizeThaiOcr()` recomposes Thai sara-am; dashboard selector. **Layer 2 finally reads Thai** — WinRT never can (no `th-TH` pack exists) |
| 32 | **Signal hygiene** | five fixes read off the *real* 3,241-event log: `normalizeTitle()` kills spinner/unread-count title churn (51% of screen events were spinner frames; 790→386), `deadline` becomes clearable + an overdue one says so, post-commit hook installed, `judgeNote()` drops junk **voice** notes (typed `capture` always kept), Advisor dedup by intent+word-overlap instead of exact title |
| 32.1 | **Log compaction** | `compact [--apply]` rewrites history with the **same pure predicates as the live path** (so past and present agree by construction); dry-run default, backup to `.executive/backup-<ts>/`, `seq` never renumbered. Applied: screen 875→433, voice notes 1431→1365 |
| 33 | **Signal → Judgment** | (a) **real bug:** `ui` never persisted `digest.md`/`notifications.jsonl` — the refresh lived inline in `case "watch"` — so Phase 14's durable log was dead in the mode the owner actually runs; extracted `runDigestTick` (`src/report/tick.ts`) and wired both daemons. (b) `State.patterns` (pure, builder-computed, keeps the Planner's "State only" contract) + 3 pattern rules: `checkpoint_work`/`grinding_on_file`/`long_session`, all `ask`. (c) Advisor proposals must cite checkable `evidence`; generic advice + busywork banned in the prompt; `parseDrafts` **drops ungrounded drafts** |
| 33.1 | **Advisor live-validated** | the first real gateway call failed and exposed 3 defects the mock could never surface: `max_tokens` starvation (**3/3 runs**, output exactly 4096 → floor raised to 8192), a failure message that couldn't distinguish "out of budget" from "bad response", and the model reading raw ms as the wrong unit (`sessionMs: 2173707` → "~36 hours"; it is 36 **minutes**) → `patternsExplained` sends units in words |
| 34 | **Autonomy toggles** | `ui` carries the Advisor / infer / autopilot triggers that used to live only in `watch`, + an **Autonomy card** that re-reads config every tick (toggle without restart). `autopilot.apply` is deliberately **not** a dashboard toggle |
| 34.1 | **Runtime robustness** | three defects found by *reading the `ui` console*: `nextSeq`'s temp+rename lost an event to a transient Windows `EPERM` (AV/indexer holds `meta.json` for ms) → `renameOverwrite()` retries only `EPERM`/`EBUSY`/`EACCES`; `Bun.serve`'s 10s default `idleTimeout` was shorter than `/api/state` on a real log → 120s; and an executor test used `test: "true"`, which **is not a command in `cmd.exe`** → `exit 0` |
| 35 | **Jarvis layer — chat with hands** | `src/agent/`: a conversational front door that answers from real state (9 read tools) and **acts** (5 write tools) — every write parks for a one-tap confirm, and "ไว้ใจ tool นี้ตลอด" persists to `config.agent.trustedTools` (removes the prompt, never a guardrail). Two tool-call protocols (`native` + a `json` fenced fallback, `auto` downgrades on a 4xx naming `tools`) because gateway support is **unmeasured — every probe hit a 524 outage**. `edit_files` reuses Synth→Executor so code lands on `executive/change-*`. Chat panel + voice in/out, `/api/chat*`, `chat` CLI. Live-validated against a stub speaking the real Anthropic shape |
| 34.2 | **Atomic-write hardening** | review of 34.1 found the retry helper fixed **1 of 17** temp+rename sites (the per-tick `writeState`/`writePlan`/`writeDigest` are more exposed than `meta.json`) and that its 3 tests **all passed against plain `renameSync`**. `renameOverwrite` moved to `src/fs-atomic.ts` with an injectable `RenameIo` seam + real retry coverage; every atomic write routed through it; `idleTimeout` derived from `llmTimeoutMs` instead of a hardcoded 120 s that **equalled** the LLM client timeout; the 81 MB model download made non-blocking (polls the existing `/api/transcribe/status`) |
| 36 | **Proactive nudges over Discord** | the system speaks FIRST: a pure `decideNudge` rule engine (first-tick guard → nothing-new → quiet hours → min-gap → daily budget → 24h repeat-suppression, ≤1 nudge/tick) + a hand-rolled Discord adapter (zero deps, WebSocket gateway + REST, `ownerId` as an **authentication boundary**). A Discord reply enters the SAME `runTurn`/`conversation.jsonl` as the dashboard. `nudges.jsonl` is the evidence log that gates the deferred `rules+llm` dial. **LIVE-confirmed** |
| 37 | **Any-repo reach + chat markdown + secrets gate** | `resolveRepo` discovers a repo by basename under `config.agent.repoSearchRoots` (unknown name → **`null`**, replacing a silent fallback that answered about the wrong repo); `list_repos` tool; `repo` arg on `read_file`/`grep`. Chat renders markdown and no longer yanks the scroll. **Secrets gate**: `.env`/keys/`.ssh` rejected by the shared path gate (found by /scrutinize after discovery widened `read_file` to 16 repos) |
| 38 | **Sandbox `run_command`** | pure `classifyCommand` → deny/allow/ask, with a **denylist in code, not config** (rm -rf, curl\|sh, sudo, git push --force, …) that `run_command.run()` hard-refuses **even after the owner confirmed**; `NEVER_TRUSTABLE = {run_command, edit_files}` makes standing trust inert in both directions (a hand-edited config.json cannot arm it) |
| — | **Discord UX + session trust** | long replies chunked to ≤2000 chars (were truncated mid-word); a tapped confirm button now edits its message in place (`type: 7`) instead of a silent `type: 6` ack; **"ไว้ใจทั้งแชทนี้"** = session-scoped trust that resets on clear, so the NEVER_TRUSTABLE tools stay un-trustable *persistently* while an inspection session stops nagging. The denylist still refuses destructive commands even when session-trusted |
| 39 (+39.1) | **State decay / TTL** | only **manually-asserted** signals age out (auto-sensed ones are refreshed by watchers, so they never decay): `BLOCKED_TTL_MS` 24 h, `MANUAL_TASK_TTL_MS` 72 h → falls back to branch/repo inference. Decay only ever *removes* a stale assertion; unparseable `ts` → keep. 39.1: deadline decay is **opt-in + default off** (a deadline is a commitment, not transient state — /scrutinize caught that auto-retiring it reverses Phase 32's nag) |
| 40 | **SQLite event storage** | `EventBackend` interface + `jsonl`/`sqlite` implementations behind an unchanged `append`/`read`/`tail`; `bun:sqlite`, no new dependency; `seq INTEGER PRIMARY KEY` so seq is the rowid (never renumbered on delete). `seq` allocation deliberately stayed in `seq.ts`/`meta.json` for both backends. `migrate-events [--apply]` is dry-run by default, never touches the `.jsonl` files, and reports a seq-with-different-id as a **conflict** instead of skipping it silently. **The live runtime now runs on sqlite** |
| — | **Agent budget ladder** | a *second* `max_tokens` failure, distinct from the think-loop: measured **1/8 answered at 8192 vs 4/4 at 32768**, with every failing attempt burning exactly 8192 — so re-sampling at the same ceiling was provably useless. `BUDGET_LADDER = [1,2,4,4]` raises the ceiling per retry instead. Live 6/6 |
| 41 | **"Make me a file" works** | the gateway's **~125 s wall clock** × 33–48 tok/s ⇒ **~4,000 output tokens is a physical ceiling**, so the budget ladder was inverted into a **context ladder** (`CONTEXT_LADDER = [null,3,1]` + `trimTranscript`); new `save_file` (confined dirs / no executables / no overwrite / NEVER_TRUSTABLE, per-folder approval, 🌿 branch option); large files arrive via `append` chunks with truncated-tool-call feedback; `run_command` had **never worked on Windows** (`sh -c`) → temp `.bat`. Owner-verified live: playable pong + tetris |
| 42 | **Nudge quality + a readable answer signal** | read the real `nudges.jsonl` (5 sent / 3 days) and found the nudge sentence was composed from the **internal dedup key** — the model read *"needs your call"* as a **phone call** in 2 of 4 live nudges. `nudgeSubject()` sends the human `detail` and **never** `summary` when a detail exists (fixed in the presentation layer — rewording `digest.ts` would invalidate every dedup key already written). `answered` gains `latencyMs`, a new `expired` record gains `ageMs`, `ANSWER_WINDOW_MS = 30 min`; `openNudgeId` treats both as closing. **The sent-vs-answered baseline restarts from here** — the old 5/5 counted replies up to 1 h 55 min later |

**Test count:** 876 passing, 100% offline (mock backends). Several phases **validated live** against the
9arm Qwen gateway (`work`, `synth`, `infer`, `propose`, the agent); Phase-25 vendor download + browser-wasm
e2e run live too. **Screen-sensing is fully live** (real capture → real OCR → real suggestions, both engines
compared on the same image), the **Advisor is live-validated end to end** (Phase 33.1), **Discord is live**
(Phase 36), and **SQLite is the live backend** (Phase 40). **Not live:** the Layer 3 vision call — it is
**403 at the gateway**, not a code problem (§6).

**Where the system stands qualitatively (measured 2026-07-23, before Phase 33):** sensing was far ahead
of reasoning — State was accurate and near-fully auto-sensed (Layer 2 OCR summarised the owner's live
work from pixels alone), yet `plan.json` was `topAction: null`: **3,174 sensed events had produced 0
decisions**, because all four Planner rules only fired when something was *broken*. Phase 33 closed that
gap; the Planner now says things like *"113 edit(s) over 11.5h with no commit — checkpoint before the
change gets too big to review"* and it reaches the "Needs you" queue.

---

## 3. How to run / continue

```bash
bun install
bun run typecheck          # tsc --noEmit (strict) — must stay green
bun test                   # 876 tests, offline
bun run test:e2e           # OPT-IN browser-wasm e2e (real Chromium via Playwright; runs under node, auto-skips
                           #   if playwright/model aren't set up — see test/e2e/README.md)
bun run test:e2e:chat      # OPT-IN chat-UI e2e (markdown render + no-yank scroll; no gateway/token needed)

bun run src/index.ts init  # create .executive/ (also adds .executive/ to .gitignore in a repo)
bun run src/index.ts ui    # dashboard at localhost:4317 (+ watches git/files); the main entry point now
bun run src/index.ts migrate-events [--apply]   # JSONL logs → .executive/events.db (dry-run without --apply)
```

**Daily use is `ui` alone.** It runs the watchers, rebuilds state + plan + digest + the durable
notification log on `state.intervalMs`, runs screen-sense Layer 2, **and (Phase 34) carries the
Advisor / infer / autopilot triggers** that used to live only in `watch`. All are off by default and
switchable from the dashboard's **Autonomy** card, which re-reads config every tick — **a toggle takes
effect without a restart**. `watch` remains the headless equivalent; running both is safe but redundant.

**`autopilot.apply` is intentionally not a dashboard toggle** — it is the only switch that lets the
runtime commit without a per-action human click, so arming it stays a deliberate `config.json` edit.
`updateAutonomyConfig` ignores it in both directions; the card only reports its state.

**Read the `ui` console — its warnings are not noise.** Phase 34.1 came entirely from two lines the owner
almost ignored: an `EPERM` on `meta.json` was silently costing events their `seq`, and a `Bun.serve`
timeout meant the dashboard was serving dead requests. A `⚠️ Needs you (…)` line, by contrast, *is* the
Planner working as designed.

**Every atomic write now goes through `renameOverwrite` in `src/fs-atomic.ts`** (Phase 34.2) — if you
add a new `.executive/` artifact, write it as temp + `renameOverwrite`, never a bare `renameSync`. On
Windows a plain rename onto an existing file is only *probabilistically* atomic (AV / the search indexer
hold a handle for a few ms), and the failure mode is silent: the caller catches, logs one line, and the
artifact is simply not updated.
Full command list is in `README.md` / `CLAUDE.md` and `printUsage()` in `src/index.ts`.

**Dev workflow (division of labor):** the architect (Claude) writes a **scope** in `docs/scopes/`, hands it
to **claude9arm** (a cheaper Qwen worker) to implement, then the architect **reviews + runs every acceptance
criterion for real** (never trusts the self-report), fixes defects, and commits. Every phase = one commit +
a `CLAUDE.md` phase entry.

- Delegate with `claude-9arm -p "<self-contained prompt>" --allowedTools Bash Read Edit Write Glob Grep`
  (there is a `qwen-agent` skill for this). The prompt must be **standalone** — qwen has none of the
  conversation's context — with absolute paths and explicit acceptance criteria.
- **⚠️ Run it from OUTSIDE the repo.** `CLAUDE.md` is now large enough that a headless `claude-9arm`
  started *inside* the repo auto-loads it and dies on the first request with
  `ContextWindowExceededError` (**99 k input tokens before doing any work**, against a 128 k window).
  Phase 34.2 lost a run to this. The working shape: `cd <scratchpad> && claude-9arm -p "…"
  --add-dir C:/Users/yiw20/Programming/myshi/executive`, with an explicit line in the prompt saying
  **"do NOT read CLAUDE.md / HANDOFF.md / GOTCHA.md — everything you need is in the spec"**, plus
  "work file by file, grep rather than reading whole files".
- **⚠️ …and forbid raw `bun test` output — that is the real context killer.** Phase 40's Job 1 died to the
  same `ContextWindowExceededError` *despite* running from outside the repo with the docs explicitly
  banned. The suite prints **750+ `(pass)` lines ≈ 20–30 k tokens per run**, and an implementer runs it
  several times (plus once per sabotage step). `CLAUDE.md` is only ~30 k; a few test runs dwarf it. Put
  **"NEVER print full test output — always `bun test 2>&1 | tail -20`"** in every delegation prompt, and
  cap the final report ("under 20 lines"). Job 2 got that instruction and survived to report.
- **A run that dies at the report stage has usually still done the work.** Both Phase 40 jobs wrote every
  file before dying / reporting. Check `git status` before assuming a failed run produced nothing — and
  then review it exactly as if it had reported success, because its acceptance criteria were never run.
- **Delegation depends on Arm's box being up.** Phase 31's runs died to a gateway outage mid-task; when
  that happens the architect finishes the work rather than blocking. Split jobs so they touch **disjoint
  files** — a parallel run whose `bun run typecheck` sees another job's half-edited file will try to
  "fix" files it was told not to touch.
- **Review qwen's output rather than trusting it.** Real defects found so far: assertions hidden inside
  un-awaited `setTimeout` (a suite that passes against deliberately broken code), a `.replace()` with a
  string instead of a global regex (fixed only the first match), whole-file rewrites via a generated
  `tmp-*.js` script that flatten non-ASCII and leave litter behind, new `it()` blocks pasted *outside*
  the `describe()` whose fixtures they use, a header comment stating the exact opposite of what the
  tests do, and a dead `const thrown = calls` placeholder where the real assertion belonged.
- **Re-run the sabotage check yourself.** Phase 34.2's qwen run reported "tests 2,3,4,5,6 failed against
  the stripped implementation" and that turned out to be exactly right — but the whole point of the
  check is that it is the one claim you cannot verify by reading the diff. Break the code, run the
  suite, restore. It costs 30 seconds.

---

## 4. LLM gateway — critical operational knowledge

- Default backend = the owner's friend "Arm"'s **local Qwen** via `https://gateway.9arm.co` (Anthropic
  Messages API shape), model `qwen3.6-35b-a3b`. **Flat-rate, not Claude** — spends no Claude quota, and the
  owner says it never hits limits, so **live calls are OK**.
- Auth token lives ONLY in gitignored `.env` under `EXECUTIVE_WORKER_KEY` (Bun auto-loads `.env` from the
  **cwd** — a common test gotcha: run from a dir that has `.env`, or copy it in, or the call 401s).
- **Qwen3.6 has a "thinking" phase** that consumes output tokens before the answer. Too small a
  `max_tokens` → `content:[]` / `stop:max_tokens` → empty/errored calls. Phase 20 fixed this with shared
  `llmMaxTokens(config, floor=4096)` + `llmTimeoutMs(config, floor=120000)` in `src/config.ts`, used by the
  worker/synth/infer/advisor factories. Latency is variable (6s–>120s); occasional timeouts are expected
  and the daemon retries. `/no_think` did NOT help (made it worse). Headroom is the lever.
- **The floor is per-caller, and 4096 is not universally enough.** Phase 33.1: the Advisor hit
  `stop_reason: max_tokens` on **3/3** live runs (output exactly 4096) once its prompt started demanding
  evidence per proposal — a longer/stricter prompt buys more *thinking*, not just more output. It floors
  at **8192** (`llmMaxTokens(config, 8192)`) and completes at ~4.5k. **If you tighten a prompt, re-measure
  the budget live** — probe the gateway directly and look at `stop_reason` + `usage.output_tokens`.
- **A truncated answer is partly salvageable.** `salvageTruncatedArray()` (`src/advisor/anthropic.ts`)
  recovers the *completed* elements of a JSON array cut off mid-object (string-aware, so braces and
  escaped quotes inside strings don't fool it) rather than throwing away a good answer for one bad tail.
- **Never hand the model raw milliseconds.** It read `sessionMs: 2173707` as "~36 hours" — it is 36
  *minutes* — and repeated the same class of error on another run, so it is systematic, not a fluke.
  `explainPatterns()` sends units in words next to the raw numbers. Prefer pre-formatted values in any
  new prompt payload.
- Response parsing tolerates code fences / surrounding prose and extracts the JSON (`parseGuesses`,
  `parseDrafts`, etc.).
- **Make the LLM justify itself, then check the justification.** Phase 33 made every Advisor proposal
  carry an `evidence` string (ungrounded drafts are dropped at parse time). It measurably killed the
  horoscope-grade output — but it does **not** stop the model inventing a *subject*: one live run cited
  `sameFileSaves30m: 9` and `currentFile` correctly while proposing work on an "invoice quotation flow"
  that appears nowhere in the context. The evidence line is what makes that visible in seconds; treat it
  as an audit trail, not a guarantee.
- **Two API shapes:** everything text (worker/synth/infer/advisor) uses the **Anthropic** `/v1/messages`
  shape. **Vision (Phase 29, `qwen-vl-max`) is different** — the gateway's multimodal endpoint is
  **OpenAI-compatible** `POST /v1/chat/completions` with `image_url` base64 data-URL content parts
  (`src/screen/vision.ts`, response text at `choices[0].message.content`). Don't force images through the
  Anthropic client. Default `screen.vision.baseUrl`/`apiKeyEnv` fall back to `config.worker.*` at use time.
- **The team can only use `qwen3.6-35b-a3b`.** Any other model → `403 team_model_access_denied`. That is
  why Layer 3 vision cannot work here; only Arm can change it.

### Diagnosing "the LLM found nothing" (three different real causes, same symptom)
Every client used to swallow errors into an empty result, so **an outage looks exactly like a quiet day**.
Phase 29.2 fixed that for screen-infer (`ocr: llm unavailable — <reason>`); the others still report empty.
When something LLM-shaped goes silent, check in this order:
1. **Corporate TLS proxy (Zscaler).** The owner's work VPN MITMs TLS; `curl` works (Windows cert store)
   but **Bun's `fetch` uses its own CA store** → `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Tell:
   `echo | openssl s_client -connect gateway.9arm.co:443` shows a `Zscaler Inc.` issuer. Fix: turn it off.
   (`NODE_EXTRA_CA_CERTS` also works, but **Bun ignores it from `.env`** — the TLS store initialises first.)
2. **Arm's inference box is down.** Cloudflare `524` after ~120s, and the direct call returns
   `litellm.InternalServerError: Cannot connect to host vllm.tetra-magellanic.ts.net:8000`. Even a
   one-word prompt times out. Nothing to fix on our side.
3. **Genuinely no signal** — only conclude this after ruling out 1 and 2 with a bare `fetch` probe.

### Windows / PowerShell gotchas (hard-won, Phase 28–31)
- **Defender/AMSI blocks screen capture:** a PowerShell script that does `CopyFromScreen` is flagged
  "malicious content" and refused — via `-Command` **and** `-File` alike. Not code-fixable without an AV
  exclusion; do **not** obfuscate to evade it (that's detection-evasion). Capture returns null → graceful.
  **An exclusion is in place on this machine**, so capture works; if it silently returns null again, check
  that first. Note this block **masked two real defects for a whole phase** — code that never runs never
  fails, so a "graceful degradation" path can hide broken code indefinitely.
- **`Image.Save(path, format, encoderParams)` does not bind** — the 3-arg overload wants an
  `ImageCodecInfo`; resolve it via `GetImageEncoders()` matched on `[ImageFormat]::Jpeg.Guid`.
- **WinRT `StorageFile` rejects mixed separators** (`C:\dir/tmp/x.jpg`) with an `AggregateException` even
  though the file exists — `normalize()` every path before it crosses into PowerShell.
- **There is no Thai OCR pack for `Windows.Media.Ocr`, and there never will be** — Windows ships 36 OCR
  languages and `th-TH` is not one. Use `config.screen.ocr.engine = "tesseract"` (Phase 31) for Thai.
- **WinRT needs STA:** `Windows.Media.Ocr` / `StorageFile` async ops fault (`AggregateException`) in an MTA
  apartment; spawn `powershell -Sta`. Await `IAsyncOperation<T>` via the `[WindowsRuntimeSystemExtensions]
  .AsTask` generic bridge (see `src/screen/ocr.ts`).
- **Unicode from PowerShell:** set `[Console]::OutputEncoding = UTF8` **and**, for window titles,
  `[DllImport(..., CharSet=CharSet.Unicode)]` (the ANSI default mangles Thai to `?`).
- **`bun -e "...'$WINPATH'..."` eats backslashes** (JS string escapes) — a *test-harness* trap, not a bug;
  pass Windows paths via `process.env`, not interpolated into the `-e` string.

---

## 5. Guardrails & decisions that MUST be preserved

- **The system never decides autonomously:** relationships, morality, large spending, life-goal changes.
  It may *propose* anything (human approves), but never auto-acts on those. Confidence > 95% → act, else ask.
- **Autonomy is opt-in, layered, default-off:** autopilot (`config.autopilot.enabled` then `.apply`),
  inference (`config.infer.enabled`), advisor (`config.advisor.enabled`), capture (`config.capture.enabled`).
  Applied changes only ever land on an isolated `executive/change-*` branch; the owner merges.
- **LLM output is untrusted:** a synthesized ChangeSet is path-safety-validated before the Executor runs it,
  even dry-run. Proposals/inference/advice are suggestions until the owner confirms.

---

## 6. Remaining work

### ✅ Screen-sensing is DONE and running — nothing is blocked
State on this machine: Defender exclusion in place, `screen.ocr.enabled = true`, `engine = "tesseract"`,
`languages = "tha+eng"`, Tesseract 5.4 + `tha.traineddata` installed. A capture writes suggestions to
`.executive/screen-inferred.json`, surfaced in the digest / dashboard "Suggestions (unconfirmed)" with a
Confirm button. Ethics held: opt-in, visible "🔴 reading screen" indicator, own-screen only.
Layer 3 (vision) stays off — `qwen-vl-max` is 403 at the gateway; it fails cleanly if enabled.

### ⏭️ Candidate A — surface `State.patterns` in the digest / dashboard
Phase 33 computes `patterns` (`sessionMs`, `msSinceLastCommit`, `editsSinceLastCommit`,
`sameFileSaves30m`, `repoSwitches1h`) and the Planner + Advisor both reason over them, but the owner
cannot see the numbers a proposal cites without opening `state.json`. A "Working pattern" line in the
digest and a Now-card row would close that loop. Cheap and read-only — the values already exist.

### ⏭️ Candidate B — pick the OCR language from the window title
`-l tha+eng` **hallucinates Thai on screens that contain none**. Measured on one real screenshot:
`-l eng` → 0 Thai chars / 8 English words; `-l tha+eng` → **59 garbage Thai chars** / 7 English words —
so `tha` also costs a little English accuracy. It is *not* a resolution artifact (native 1536×960 gives
the same garbage), and the LLM still read the screen correctly, so this is noise rather than breakage.

The fix is cheap and uses what already exists: Layer 1 already puts the active window title in
`State.currentWindow` **with Thai intact** (it is a `GetWindowTextW` call, not OCR). Derive the language
list from it — Thai characters in the title → `tha+eng`, otherwise `eng` — instead of always sending both.
`config.screen.ocr.languages` stays the manual override. Everything needed is in `src/state/types.ts`
(`currentWindow`) and `src/screen/screen-infer.ts` (which already reads the config block).

### Needs the owner (to go live — code is complete)
Transcription now has **three working backends** (Phase 25); pick one in the dashboard **Settings** card:
- **Groq** (`whisper-api` preset) — free tier ~2000 req/day. Put the key in `.env` under
  `EXECUTIVE_TRANSCRIBE_KEY`, click the Groq preset, Save. Best "works today", great Thai↔English.
- **Local faster-whisper** (`whisper-api` preset) — host a `/v1/audio/transcriptions` server (e.g.
  `speaches`/`whisper.cpp`) on your machine; click the Local preset, set the URL, Save. Private, no cloud.
- **Browser-WASM** (`browser-wasm` mode) — run `download-model` (or the Settings "Download" button) once
  (~100MB into `.executive/vendor`+`/models`), then it transcribes **in the browser, fully offline**. The
  vendor download is verified working; the in-browser transcription needs one real-browser test (browser-only,
  like Web Speech).
- **Web Speech** (`webspeech`, default) — no setup, browser recognizer, one language at a time.

### Deliberately deferred (need an owner decision or real pain)
- **External delivery** — **done for Discord (Phase 36)**: nudges + approvals reach the owner by DM and a
  reply re-enters the same conversation. Email/Slack remain deferred (each is another outward-facing
  channel needing its own approval); `notifications.jsonl` / `nudges.jsonl` are the local substrate.
- **SQLite** storage — **DONE (Phase 40) and now live.** *Drizzle specifically was dropped on purpose:*
  the event log is one table with three query shapes (append / read by source / tail by seq), so an ORM
  would add a dependency and a schema layer for nothing. Revisit only if a second table appears.
- **A db→jsonl exporter** — `migrate-events` is deliberately one-way. Nothing needs the reverse yet, but
  it is the gap that makes a rollback to `"jsonl"` lossy for anything appended since the flip.
- **A backup of `.executive/config.json`** — it is gitignored, hand-edited, holds the only copy of
  `discord.ownerId`/`repoSearchRoots`/OCR settings, and **was destroyed once in this session with no way
  to recover it**. The `execRoot()` guardrail stops the specific cause; it does not create a backup.
- **`rules.md` / `planner.md`** — the vision's remaining 4-layer artifacts (editable decision rules /
  long-term goals). Speculative; rules already live as code in `src/planner/rules.ts`.
- **Wiring approved proposals to real execution** — **partly done (Phase 27):** approving an *executable
  code* proposal now runs Synth→Executor onto an isolated branch. *Life/money/relationship/goal* proposals
  are still record-only by design (the `sanitizeExecutable()` filter forces it) — they have no "hands" for
  irreversible real-world actions, and that boundary is intentional.
- **Screen-sensing beyond title** is fully live (Phase 29/29.1/29.2/31). No always-on/hidden capture —
  deliberately out of scope (third-party consent), and that boundary was re-affirmed when asked to make
  listening covert.
- **A better Thai OCR pipeline** (confidence filtering via Tesseract's TSV output, `--psm` tuning,
  cropping to the foreground window instead of the whole screen). Only worth it if the noise above
  actually degrades suggestions — right now it does not.

---

## 7. Layout quick-map

```
src/
├── events/        # EventStore: store.ts is a thin dispatcher over backend.ts
│                  #   jsonl-backend.ts | sqlite-backend.ts (bun:sqlite) — chosen by config.storage.backend
│                  #   seq.ts/meta.json allocate seq for BOTH backends; migrate.ts = one-way jsonl→db
├── agent/         # the conversational front door (chat + Discord): tools, loop, protocol, session
│                  #   command-guard.ts = the run_command denylist (a guardrail in code, not config)
├── proactive/     # rules.ts decides WHEN to nudge (pure); compose.ts writes the sentence; log.ts
├── channel/       # Discord adapter (hand-rolled, zero deps) — ownerId is an auth boundary
├── watchers/      # git + fs watchers
├── state/         # State Builder (state.json/context.json) — incl. task/project inference
│                  #   patterns.ts = behavioural metrics (pure) so the Planner can read State only
├── planner/       # rule-based Planner (plan.json) + rules.ts (4 breakage rules + 3 pattern rules)
├── worker/        # LLM Worker (Proposal) — mock|anthropic + identity (claude.md)
├── executor/      # applies ChangeSet on isolated branch (git, deterministic)
├── synth/         # Synthesizer (Proposal→ChangeSet)
├── auto/          # Autopilot orchestrator + guard (continuous-autonomy dedup)
├── report/        # Digest (digest.md, "Needs you") + notify (notifications.jsonl)
│                  #   tick.ts = the shared digest+notification step BOTH `watch` and `ui` must call
├── capture/       # judgeNote() — drops junk voice notes before they reach the Advisor
├── compact/       # `compact` — rewrites history with the same predicates as the live path
├── infer/         # LLM block/deadline guesses (inferred.json)
├── advisor/       # proactive proposal queue (advisor.json)
├── hooks/         # install-hooks (post-commit test emitter)
├── screen/        # Layer 1 capture.ts (window title) + Layer 2/3 screenshot.ts/ocr.ts/vision.ts/screen-infer.ts
│                  #   ocr.ts holds BOTH engines: runWinRtOcr (PowerShell/WinRT) + Tesseract (plain exe)
├── watchers/      # git + fs + screen (Layer 1) watchers; build.ts (multi-repo watcher assembly)
├── ui/            # Bun.serve dashboard (server.ts + page.ts) + models.ts (browser-wasm asset fetch)
├── config.ts  paths.ts  bootstrap.ts  index.ts (CLI)
.executive/        # runtime data (gitignored): config.json, claude.md, events/ (now FROZEN — the backup),
                   #   events.db (+ -wal/-shm) = THE LIVE EVENT STORE, meta.json (seq),
                   #   state/plan/digest/context, proposal/changeset/exec-report, auto-report,
                   #   notifications.jsonl, nudges.jsonl, conversation.jsonl, inferred, advisor.json,
                   #   vendor/ + models/ (browser-wasm transformers.js + Whisper model, served from 127.0.0.1)
docs/scopes/       # per-phase specs
CLAUDE.md          # authoritative phase log + workflow + guardrails
README.md          # user-facing overview
```
