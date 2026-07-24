// Command classification for the agent's run_command tool (Phase 38).
//
// run_command runs `sh -c <anything>` with the owner's privileges — the single riskiest
// tool. This module is a PURE classifier over the command string. It does not run anything;
// tools.ts consults it and refuses (deny) or annotates the confirm chip (allow/ask).
//
// Design (owner's call, Phase 38): "confirm always + denylist blocks".
//   - DENY  → run_command.run() hard-refuses; it NEVER spawns, even if the owner confirmed.
//             The denylist is a GUARDRAIL: it lives here in code, not in config, and cannot
//             be weakened from the dashboard.
//   - ALLOW → advisory only. A known-safe prefix is BADGED "✓ known-safe"; it still requires
//             the owner's tap. Extendable (never shrinkable) via config.agent.commandAllowlist.
//   - ASK   → the default; the normal per-action confirmation.

import type { Config } from "../config.js";

export type CommandDecision = "deny" | "allow" | "ask";

export interface CommandVerdict {
  decision: CommandDecision;
  /** Present for deny (why refused) and allow (which rule matched). */
  reason?: string;
}

/**
 * Destructive patterns. Matched anywhere in the whitespace-normalized command, case-insensitive.
 * Deny is checked BEFORE the chaining short-circuit, so a destructive tail after `&&`/`|`/`;`
 * (`git status && rm -rf build`) is still caught.
 *
 * This targets DESTRUCTION, not exfiltration — data leaving the machine is explicitly out of
 * scope (a limitation, not an oversight; see the phase scope §7).
 */
const DENY: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(?:-[a-z]*[rf][a-z]*|--(?:recursive|force))/i, why: "recursive/forced delete" },
  { re: /\b(?:sudo|doas)\b/i, why: "privilege escalation" },
  {
    re: /\b(?:curl|wget|iwr|invoke-webrequest|fetch)\b[^|]*\|\s*(?:sh|bash|zsh|dash|python\d?|perl|node|ruby)\b/i,
    why: "downloading a script straight into a shell",
  },
  { re: /:\s*\|\s*:\s*&/, why: "fork bomb" },
  { re: /\bmkfs\b/i, why: "formatting a filesystem" },
  { re: /\bdd\b[^;&|]*\bof=\/dev\//i, why: "writing raw to a device" },
  { re: />\s*\/dev\/(?:sd|nvme|hd|mmcblk|vd)/i, why: "redirect onto a block device" },
  { re: /\b(?:shutdown|reboot|halt|poweroff)\b/i, why: "powering the machine down" },
  { re: /\binit\s+[06]\b/i, why: "changing runlevel (halt/reboot)" },
  { re: /\bchmod\s+-[a-z]*R[a-z]*\s+0?777\b/i, why: "recursive world-writable permissions" },
  { re: /\bchmod\s+0?777\s+\//i, why: "world-writable permissions on root" },
  { re: /\bchown\b[^;&|]*-[a-z]*R[a-z]*[^;&|]*\s\/(?:\s|$)/i, why: "recursive chown of root" },
  { re: /\bgit\s+push\b[^;&|]*(?:--force\b|--force-with-lease\b|\s-f\b)/i, why: "force-pushing (rewrites remote history)" },
  { re: /\bgit\s+reset\b[^;&|]*--hard/i, why: "hard reset (discards uncommitted work)" },
  { re: /\bgit\s+clean\b[^;&|]*-[a-z]*f/i, why: "deleting untracked files" },
  { re: /\bfind\b[^;&|]*(?:-delete\b|-exec\b)/i, why: "find with -delete/-exec" },
  { re: /\bdel\s+\/[a-z]/i, why: "recursive/force delete (Windows)" },
  { re: /\br(?:m)?dir\s+\/s/i, why: "recursive directory delete (Windows)" },
  { re: /\bformat\s+[a-z]:/i, why: "formatting a drive (Windows)" },
];

/**
 * Shell chain/redirect metacharacters. A command containing any of these can never earn the
 * "known-safe" badge — the badge is a promise about a SINGLE simple command, and a chain could
 * hide anything after the safe-looking head. (Deny is still checked first, so a destructive
 * chain is denied, not merely un-badged.)
 */
const CHAINING = /[;&|`]|\$\(|>|<|\n/;

/**
 * Known-safe command prefixes (advisory). A command that (a) has no chaining metacharacter and
 * (b) starts with one of these at a token boundary is badged "✓ known-safe". Still confirmed.
 * `find` is here but `find … -delete`/`-exec` is in DENY — deny wins (checked first).
 */
const ALLOW_DEFAULT: string[] = [
  "bun test", "bun run", "bun install", "bun x", "bunx",
  "npm test", "npm run", "npm ci", "npm install", "npm ls", "npm audit",
  "pnpm test", "pnpm run", "pnpm install", "pnpm i",
  "yarn test", "yarn run", "yarn install",
  "tsc",
  "git status", "git log", "git diff", "git branch", "git show",
  "git fetch", "git rev-parse", "git remote", "git describe", "git blame",
  "ls", "cat", "pwd", "echo", "head", "tail", "wc", "grep", "rg", "find",
  "which", "whoami", "date", "node --version", "bun --version", "npm --version",
];

function normalize(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim();
}

/** Does `cmd` start with `prefix` at a token boundary? (case-insensitive) */
function startsWithToken(cmd: string, prefix: string): boolean {
  const c = cmd.toLowerCase();
  const p = prefix.toLowerCase();
  return c === p || c.startsWith(p + " ");
}

/**
 * Classify a shell command. Order: deny (anywhere) → chaining short-circuit → allow prefix → ask.
 * `config` only widens the allow list (config.agent.commandAllowlist); it can never shrink DENY.
 */
export function classifyCommand(cmd: string, config?: Config): CommandVerdict {
  const norm = normalize(String(cmd ?? ""));
  if (norm === "") return { decision: "ask" };

  for (const rule of DENY) {
    if (rule.re.test(norm)) return { decision: "deny", reason: rule.why };
  }

  // A chained/redirected command cannot be certified safe — but it is not denied here either.
  if (CHAINING.test(norm)) return { decision: "ask" };

  const extra = (config?.agent?.commandAllowlist ?? []).filter(
    (p): p is string => typeof p === "string" && p.trim() !== ""
  );
  const allow = [...ALLOW_DEFAULT, ...extra];
  for (const prefix of allow) {
    if (startsWithToken(norm, prefix)) return { decision: "allow", reason: prefix };
  }

  return { decision: "ask" };
}
