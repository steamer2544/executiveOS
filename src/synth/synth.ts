// Orchestrator — runSynth: Proposal → LLM → ChangeSet → validate → dry-run executor.
// This is the bridge between Phase 5 (Worker/Proposal) and Phase 6 (Executor/ChangeSet).

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChangeSet, ExecReport, ValidationResult } from "../executor/types.js";
import { validateChangeSet, applyChangeSet } from "../executor/executor.js";
import { buildState } from "../state/builder.js";
import type { Config } from "../config.js";
import type { Proposal } from "../worker/types.js";
import { proposalPath, proposalsDir, execRoot, changeSetPath, synthReportPath } from "../paths.js";
import type { SynthFile, SynthInput, SynthOptions, SynthReport, Synthesizer } from "./types.js";
import { createSynthesizer } from "./factory.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load a Proposal from disk.
 * If proposalId is given, read from proposals/<id>.json; otherwise proposal.json.
 */
function loadProposal(proposalId: string | null): Proposal | null {
  let p: Proposal | null = null;
  try {
    if (proposalId) {
      const path = proposalsDir() + "/" + proposalId + ".json";
      if (!existsSync(path)) return null;
      p = JSON.parse(readFileSync(path, "utf-8")) as Proposal;
    } else {
      const path = proposalPath();
      if (!existsSync(path)) return null;
      p = JSON.parse(readFileSync(path, "utf-8")) as Proposal;
    }
  } catch {
    return null;
  }
  return p;
}

/**
 * Select files to feed to the LLM.
 * If explicitFiles is a non-empty array, use it.
 * Otherwise derive from State: currentFile + recentFiles.
 * Cap to config.synth.maxFiles.
 */
function selectFiles(
  repoRoot: string,
  explicitFiles: string[] | undefined,
  maxFiles: number
): string[] {
  let paths: string[];
  if (explicitFiles && explicitFiles.length > 0) {
    paths = explicitFiles;
  } else {
    // Derive from State.
    const s = buildState().state;
    const parts: string[] = [];
    if (s.currentFile) parts.push(s.currentFile);
    for (const f of s.recentFiles) {
      if (!parts.includes(f)) parts.push(f);
    }
    paths = parts;
  }
  // Dedupe preserving order.
  const deduped: string[] = [];
  for (const p of paths) {
    if (!deduped.includes(p)) deduped.push(p);
  }
  return deduped.slice(0, maxFiles);
}

/**
 * Assemble file material: read each selected file into a SynthFile.
 * Skip files that don't exist or exceed maxFileBytes.
 */
function assembleFiles(
  repoRoot: string,
  selectedPaths: string[],
  maxFileBytes: number
): { files: SynthFile[]; messages: string[] } {
  const files: SynthFile[] = [];
  const messages: string[] = [];
  for (const rel of selectedPaths) {
    const fullPath = resolve(repoRoot, rel);
    if (!existsSync(fullPath)) {
      messages.push("skip (not found): " + rel);
      continue;
    }
    const content = readFileSync(fullPath, "utf-8");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > maxFileBytes) {
      messages.push("skip (too large, " + bytes + " bytes): " + rel);
      continue;
    }
    files.push({ path: rel, content, bytes });
  }
  return { files, messages };
}

// ─── Atomic writes ────────────────────────────────────────────────────────────

/**
 * Atomically write a ChangeSet to .executive/changeset.json.
 * Writes to a temp file then renames.
 */
export function writeChangeSet(cs: ChangeSet): void {
  const dir = execRoot();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content = JSON.stringify(cs, null, 2) + "\n";
  const tmpPath = changeSetPath() + "." + randomUUID();
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, changeSetPath());
}

/**
 * Atomically write a SynthReport to .executive/synth-report.json.
 * Writes to a temp file then renames.
 */
export function writeSynthReport(r: SynthReport): void {
  const dir = execRoot();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content = JSON.stringify(r, null, 2) + "\n";
  const tmpPath = synthReportPath() + "." + randomUUID();
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, synthReportPath());
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run the full synthesis pipeline:
 *   load proposal → select files → synthesize → validate → dry-run executor → report
 *
 * When `opts.instruction` is set, skip loading `proposal.json` and use the
 * instruction text directly as the synthesis prompt. Backward-compatible:
 * when absent, behavior is byte-identical to today.
 */
export async function runSynth(opts: SynthOptions): Promise<SynthReport> {
  const messages: string[] = [];

  // 1. Load the proposal (or use instruction override).
  let proposal: Proposal;
  let proposalId: string | null;
  if (opts.instruction) {
    // Instruction override — skip proposal.json entirely.
    proposal = {
      id: "instruction",
      generatedAt: new Date().toISOString(),
      status: "ok",
      backend: "instruction",
      action: { kind: "instruction" as any, reason: "", priority: 0, confidence: 0, forbidden: false, disposition: "act" as any },
      summary: opts.instruction,
      steps: [],
      raw: opts.instruction,
      error: null,
      basedOn: { stateGeneratedAt: new Date().toISOString(), topActionKind: "instruction" as any },
    } as Proposal;
    proposalId = "instruction";
  } else {
    const loaded = loadProposal(opts.proposalId ?? null);
    if (!loaded) {
      return {
        ok: false,
        proposalId: null,
        synthesizer: null,
        selectedFiles: [],
        changeSetWritten: false,
        validation: { ok: false, errors: [] },
        execReport: null,
        messages: ["no proposal found — run `work` first"],
        error: null,
        generatedAt: new Date().toISOString(),
      };
    }
    proposal = loaded;
    proposalId = loaded.id;
  }

  if (proposal.status !== "ok") {
    return {
      ok: false,
      proposalId,
      synthesizer: null,
      selectedFiles: [],
      changeSetWritten: false,
      validation: { ok: false, errors: [] },
      execReport: null,
      messages: ["proposal has no actionable steps (status: " + proposal.status + ")"],
      error: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // 2. Select files.
  const maxFiles = (opts.config.synth?.maxFiles ?? 10) || 10;
  const selectedPaths = selectFiles(opts.repoRoot, opts.explicitFiles, maxFiles);

  // 3. Assemble file material.
  const maxFileBytes = (opts.config.synth?.maxFileBytes ?? 100000) || 100000;
  const { files, messages: asmMessages } = assembleFiles(opts.repoRoot, selectedPaths, maxFileBytes);
  messages.push(...asmMessages);

  // 4. Build input.
  const input: SynthInput = {
    proposal,
    summary: proposal.summary,
    files,
  };

  // 5. Synthesize.
  const synth = opts.synthOverride ?? createSynthesizer(opts.config);
  let result: Awaited<ReturnType<Synthesizer["synthesize"]>>;
  try {
    result = await synth.synthesize(input);
  } catch (err) {
    return {
      ok: false,
      proposalId,
      synthesizer: synth.name,
      selectedFiles: files.map((f) => f.path),
      changeSetWritten: false,
      validation: { ok: false, errors: [] },
      execReport: null,
      messages: ["synthesizer failed: " + (err as Error).message],
      error: (err as Error).message,
      generatedAt: new Date().toISOString(),
    };
  }

  // 6. Write the candidate ChangeSet (always, for inspection).
  writeChangeSet(result.changeSet);
  messages.push("wrote: " + changeSetPath());

  // 7. Validate.
  const validation = validateChangeSet(result.changeSet, opts.repoRoot);
  if (!validation.ok) {
    for (const e of validation.errors) {
      messages.push("validation error: " + e);
    }
    return {
      ok: false,
      proposalId,
      synthesizer: result.backend,
      selectedFiles: files.map((f) => f.path),
      changeSetWritten: true,
      validation,
      execReport: null,
      messages,
      error: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // 8. Dry-run the Executor. NEVER apply: true.
  const execReport = applyChangeSet(result.changeSet, {
    apply: false,
    repoRoot: opts.repoRoot,
    config: opts.config,
  });
  messages.push("dry-run: " + (execReport.ok ? "all ops would succeed" : "some ops would fail"));
  for (const op of execReport.plannedOps) {
    messages.push("  " + op.op + " " + op.path + " — " + op.effect + (op.wouldSucceed ? "" : " (BLOCKED)"));
  }
  messages.push("review " + changeSetPath() + ", then: execute " + changeSetPath() + " --apply");

  // 9. Fill report.
  return {
    ok: execReport.ok,
    proposalId,
    synthesizer: result.backend,
    selectedFiles: files.map((f) => f.path),
    changeSetWritten: true,
    validation,
    execReport,
    messages,
    error: null,
    generatedAt: new Date().toISOString(),
  };
}
