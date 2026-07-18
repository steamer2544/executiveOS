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
