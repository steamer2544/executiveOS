/** Data types for the Executor — a deterministic, rule-based change applier. */

/** A single file operation. Paths are repo-relative. */
export type FileOp =
  | { op: "write"; path: string; content: string } // create OR overwrite (upsert)
  | { op: "create"; path: string; content: string } // create ONLY — fails if the file exists
  | { op: "delete"; path: string }; // delete — fails if the file is missing

/** The unit the Executor applies. Usually hand-authored (Phase 7 generates it from a Proposal). */
export interface ChangeSet {
  id: string; // stable identifier; used in the branch name executive/change-<id>
  title: string; // short human description
  ops: FileOp[]; // ordered file operations (applied top to bottom)
  test: string | null; // optional shell command run after apply; null = none
  commitMessage: string; // commit message used on the isolated branch
  basedOnProposal?: string | null; // optional provenance: a Phase 5 proposal id
}

export interface ValidationResult {
  ok: boolean;
  errors: string[]; // human-readable; empty when ok
}

/** One line of the dry-run plan. */
export interface PlannedOp {
  op: FileOp["op"];
  path: string;
  effect: string; // e.g. "create new file", "overwrite (1024 -> 2048 bytes)", "delete"
  wouldSucceed: boolean; // false when the op would fail
  note?: string; // reason when wouldSucceed is false
}

export interface ApplyOptions {
  apply: boolean; // false = dry-run (default); true = mutate
  repoRoot: string; // repository root (usually process.cwd())
  config: Config; // for branchPrefix + defaultTestCommand
}

/** Shared config reference (subset — only executor fields matter). */
export interface Config {
  executor?: {
    branchPrefix?: string;
    defaultTestCommand?: string | null;
  };
}

export interface ExecReport {
  changeSetId: string;
  title: string;
  mode: "dry-run" | "apply";
  ok: boolean; // overall success (validation + plan + apply/test as applicable)
  validation: ValidationResult;
  plannedOps: PlannedOp[];
  // apply-mode fields (null in dry-run):
  branch: string | null; // executive/change-<id>
  originalBranch: string | null;
  committed: boolean; // whether a commit was made on the branch
  commitSha: string | null;
  testCommand: string | null;
  testPassed: boolean | null; // null when no test command
  testOutput: string | null; // stdout+stderr, truncated to ~4000 chars
  messages: string[]; // human-readable log of what happened / why it stopped
  generatedAt: string; // ISO
}
