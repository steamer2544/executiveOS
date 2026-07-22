// CLI entry point for ExecutiveOS.
// Parse process.argv hand-rolled (no CLI framework).

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { bootstrap } from "./bootstrap.js";
import { append, read, tail } from "./events/store.js";
import type { EventSource } from "./events/types.js";
import { isValidType } from "./events/types.js";
import { execRoot, logsDir, statePath, contextPath, planPath, proposalPath, execReportPath } from "./paths.js";
import { EventBus } from "./bus.js";
import { attachStoreSink } from "./sink.js";
import { WatcherManager } from "./watchers/index.js";
import { buildWatchers } from "./watchers/build.js";
import { loadConfig } from "./config.js";
import { buildState, writeState } from "./state/builder.js";
import { plan, writePlan } from "./planner/planner.js";
import { runWorker, writeProposal } from "./worker/orchestrator.js";
import { applyChangeSet, writeReport } from "./executor/executor.js";
import { runSynth, writeSynthReport } from "./synth/synth.js";
import { changeSetPath, autoReportPath } from "./paths.js";
import { runAuto, writeAutoReport } from "./auto/auto.js";
import { shouldRunAutopilot, freshGuardState } from "./auto/guard.js";
import { buildDigest, renderDigest, writeDigest, needsYouSignature } from "./report/digest.js";
import { digestPath } from "./paths.js";
import { diffNeedsYou, appendNotifications, readNotifications } from "./report/notify.js";
import type { NeedsYouItem } from "./report/types.js";
import { installHooks } from "./hooks/install.js";
import { startUiServer } from "./ui/server.js";
import { runInference, writeInference } from "./infer/infer.js";
import { inferredPath } from "./paths.js";
import { runAdvisor, decideProposal } from "./advisor/advisor.js";
import { readStore, pending } from "./advisor/store.js";
import { runScreenInference } from "./screen/screen-infer.js";
import { screenInferredPath } from "./paths.js";
import { setScreenActivity } from "./ui/server.js";

/** Atomically write a ScreenInferResult to .executive/screen-inferred.json (mirrors writeInference). */
function writeScreenInferred(result: { layer: string; suggestions: unknown[] }): void {
  const path = screenInferredPath();
  const record = { generatedAt: new Date().toISOString(), layer: result.layer, suggestions: result.suggestions };
  const tmp = path + "." + randomUUID();
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, path);
}

const VALID_SOURCES: EventSource[] = ["git", "terminal", "editor", "system", "screen"];

function printUsage(): void {
  process.stdout.write(`
ExecutiveOS — event-driven personal assistant runtime

Usage: bun run src/index.ts <command> [args]

Commands:
  init                                          Initialize .executive/ directory
  emit <source> <type> [json-data]              Append an event
  tail [n] [source]                             Show last n events
  build-state                                   Build state.json and context.json
  plan                                          Build state + plan.json
  work                                          Build state + plan, then run the Worker if actionable
  watch                                         Start the watcher daemon
  execute <changeset.json> [--apply]            Apply a ChangeSet on an isolated branch (dry-run without --apply)
  synth [--files a,b] [--proposal <id>]         Synthesize a ChangeSet from the latest Proposal (dry-run; does NOT apply)
  auto [--apply] [--files a,b]                  Run the whole chain (plan→work→synth→execute); dry-run unless --apply
  report                                        Render a human-readable digest of the current state
  notifications [n]                             Show the last n "Needs you" notifications (default 10)
  install-hooks [--test "<cmd>"]                Install a git post-commit hook that auto-emits test results
  ui [--port N] [--no-watch]                    Open a local web dashboard (also watches git+files unless --no-watch)
  infer                                         Ask the LLM to guess block/deadline (suggestions only) → inferred.json
  propose                                       Ask the Advisor for proactive proposals (adds to the queue)
  proposals                                     List the pending proposals awaiting your approval
  approve <proposalId> [--apply] [--note ".."]  Approve a proposal (runs Synth→Executor if executable)
  dismiss <proposalId>                          Reject a pending proposal
  capture <note>                                Capture a quick note (feeds the Advisor); the dashboard also does this by voice
  download-model [id]                           Download a browser-wasm Whisper model for offline transcription
  --help                                        Show this help

Sources: git, terminal, editor, system, screen

Examples:
  bun run src/index.ts init
  bun run src/index.ts emit system system.note '{"msg":"hello"}'
  bun run src/index.ts tail 5
  bun run src/index.ts tail 10 git
  bun run src/index.ts watch
`);
}

/** Format a short display string for an event. */
function formatEventLine(e: { seq: number; ts: string; type: string; data: Record<string, unknown> }): string {
  const shortData = Object.entries(e.data)
    .slice(0, 2)
    .map(([k, v]) => k + "=" + (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ");
  return "#" + e.seq + " " + e.ts + " " + e.type + (shortData ? " " + shortData : "");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "init": {
      await bootstrap();
      process.stdout.write("initialized: " + execRoot() + "\n");
      // In a git repo, make sure .executive/ (runtime data) is gitignored.
      try {
        const cwd = process.cwd();
        if (existsSync(cwd + "/.git")) {
          const giPath = cwd + "/.gitignore";
          const existing = existsSync(giPath) ? readFileSync(giPath, "utf-8") : "";
          const hasEntry = existing.split(/\r?\n/).some((l) => l.trim() === ".executive/" || l.trim() === ".executive");
          if (!hasEntry) {
            const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
            writeFileSync(giPath, existing + prefix + ".executive/\n");
            process.stdout.write("added .executive/ to .gitignore\n");
          }
        }
      } catch {
        // Never fail init over .gitignore housekeeping.
      }
      process.exit(0);
      break;
    }

    case "emit": {
      if (args.length < 3) {
        process.stderr.write("Error: emit requires <source> <type> [json-data]\n");
        process.exit(1);
      }

      const source = args[1] as EventSource;
      const type = args[2]!;
      const rawData = args[3] ?? "{}";

      if (!VALID_SOURCES.includes(source)) {
        process.stderr.write(
          'Error: invalid source "' +
            source +
            '". Must be one of: ' +
            VALID_SOURCES.join(", ") +
            "\n"
        );
        process.exit(1);
      }

      if (!isValidType(source, type)) {
        process.stderr.write(
          'Error: invalid type "' +
            type +
            '" for source "' +
            source +
            '". Type must be prefixed with "' +
            source +
            '."\n'
        );
        process.exit(1);
      }

      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(rawData);
      } catch {
        process.stderr.write(
          'Error: malformed JSON data: "' + rawData + '"\n'
        );
        process.exit(1);
      }

      const event = await append({ source, type, data });
      process.stdout.write(JSON.stringify(event) + "\n");
      process.exit(0);
      break;
    }

    case "tail": {
      const nArg = args[1] ? parseInt(args[1], 10) : 10;
      const sourceArg = args[2] as EventSource | undefined;

      if (isNaN(nArg) || nArg < 1) {
        process.stderr.write("Error: n must be a positive integer\n");
        process.exit(1);
      }

      if (sourceArg && !VALID_SOURCES.includes(sourceArg)) {
        process.stderr.write(
          'Error: invalid source "' +
            sourceArg +
            '". Must be one of: ' +
            VALID_SOURCES.join(", ") +
            "\n"
        );
        process.exit(1);
      }

      const events = await tail(nArg, sourceArg ?? undefined);
      for (const event of events) {
        process.stdout.write(JSON.stringify(event) + "\n");
      }
      process.exit(0);
      break;
    }

    case "build-state": {
      await bootstrap();
      try {
        const built = buildState();
        writeState(built);
        process.stdout.write(statePath() + " — " + built.context.summary + "\n");
        process.exit(0);
      } catch (err) {
        process.stderr.write("Error: " + (err as Error).message + "\n");
        process.exit(1);
      }
      break;
    }

    case "plan": {
      await bootstrap();
      try {
        const built = buildState();
        writeState(built);
        const p = plan(built.state, built.context);
        writePlan(p);
        process.stdout.write(planPath() + " — " + p.summary + "\n");
        process.exit(0);
      } catch (err) {
        process.stderr.write("Error: " + (err as Error).message + "\n");
        process.exit(1);
      }
      break;
    }

    case "work": {
      await bootstrap();
      try {
        const config = loadConfig();
        const built = buildState();
        writeState(built);
        const p = plan(built.state, built.context);
        writePlan(p);
        const proposal = await runWorker(built.context, p, config);
        if (!proposal) {
          process.stdout.write(
            "No actionable topAction (nothing to do or disposition=ask).\n"
          );
          process.exit(0);
        }
        writeProposal(proposal);
        process.stdout.write(
          proposalPath() + " — [" + proposal.status + "] " + proposal.summary + "\n"
        );
        process.exit(0);
      } catch (err) {
        process.stderr.write("Error: " + (err as Error).message + "\n");
        process.exit(1);
      }
      break;
    }

    case "watch": {
      // Daemon mode: bootstrap → EventBus → StoreSink → Watchers → run until SIGINT.
      await bootstrap();

      const config = loadConfig();
      const bus = new EventBus();

      // Rolling log file for full event mirroring.
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const logFilePath = logsDir() + "/watch-" + dateStr + ".log";

      // The single persisting sink. On each persisted event (now carrying its
      // seq), print a concise line to stdout and mirror the full event to the
      // rolling log file.
      attachStoreSink(bus, (stored) => {
        process.stdout.write(formatEventLine(stored) + "\n");
        try {
          writeFileSync(logFilePath, JSON.stringify(stored) + "\n", { flag: "a" });
        } catch {
          // Ignore log write errors — never crash the daemon over logging.
        }
      });

      // Build enabled watchers from config.
      const { watchers, activeNames } = buildWatchers(config);

      const manager = new WatcherManager(bus, watchers);
      await manager.startAll();

      process.stdout.write("ExecutiveOS watch started. Active watchers: " + activeNames.join(", ") + "\n");
      if (config.watch?.repos && config.watch.repos.length > 0) {
        process.stdout.write(
          "Watching repos: " + config.watch.repos.map((r) => r.name).join(", ") + "\n",
        );
      }
      process.stdout.write("Runtime root: " + execRoot() + "\n");

      // ── Autopilot banner ─────────────────────────────────────────────────
      if (config.autopilot?.enabled !== true) {
        process.stdout.write("Autopilot: OFF (observe + rebuild only)\n");
      } else if (config.autopilot.apply !== true) {
        process.stdout.write("Autopilot: ON — dry-run (proposes, never commits)\n");
      } else {
        process.stdout.write("Autopilot: ON — APPLY (commits to executive/change-* branches)\n");
      }

      // ── Autopilot guard state + in-flight lock ────────────────────────────
      const autopilotGuard = freshGuardState();
      let autopilotRunning = false;

      // ── Inference (LLM guesses) state ─────────────────────────────────────
      let inferRunning = false;
      let lastInferAt: number | null = null;

      // ── Advisor (proactive proposals) state ───────────────────────────────
      let advisorRunning = false;
      let lastAdvisorAt: number | null = null;

      // ── Screen inference state ─────────────────────────────────────────
      let screenRunning = false;
      let lastScreenAt: number | null = null;

      // ── Needs-you alert state ─────────────────────────────────────────────
      let lastNeedsSignature: string | null = null;
      let lastNeedsItems: NeedsYouItem[] = [];

      // ── Periodic state rebuild ───────────────────────────────────────────
      const stateIntervalMs = config.state?.intervalMs ?? 30000;

      // Shared rebuild + autopilot helper (called at startup and on each interval).
      async function runRebuild(): Promise<void> {
        try {
          const built = buildState();
          writeState(built);
          try {
            const p = plan(built.state, built.context);
            writePlan(p);
            if (config.worker?.autoInvoke === true) {
              try {
                const proposal = await runWorker(built.context, p, config);
                if (proposal) {
                  writeProposal(proposal);
                  process.stdout.write("Worker: [" + proposal.status + "] " + proposal.summary + "\n");
                }
              } catch (workerErr) {
                process.stderr.write("Worker failed: " + (workerErr as Error).message + "\n");
              }
            }

            // ── Autopilot ──────────────────────────────────────────────
            if (config.autopilot?.enabled === true && !autopilotRunning) {
              const latestSeq = built.context.recentEvents.length > 0
                ? built.context.recentEvents[built.context.recentEvents.length - 1]!.seq
                : 0;
              const now = Date.now();
              const decision = shouldRunAutopilot({
                config, state: built.state, plan: p, latestSeq, guard: autopilotGuard, now,
              });
              if (!decision.run) {
                process.stdout.write("Autopilot: skip — " + decision.reason + "\n");
              } else {
                autopilotRunning = true;
                try {
                  const report = await runAuto({
                    repoRoot: process.cwd(),
                    config,
                    apply: config.autopilot.apply === true,
                  });
                  writeAutoReport(report);
                  let summary = "Autopilot: " + report.stage + " ok=" + report.ok + " needsHuman=" + report.needsHuman;
                  if (report.applied) {
                    summary += " branch=" + report.branch + " commit=" + report.commitSha + " testPassed=" + (report.testPassed ?? "n/a");
                  }
                  process.stdout.write(summary + "\n");
                } catch (err) {
                  process.stderr.write("Autopilot failed: " + (err as Error).message + "\n");
                } finally {
                  autopilotGuard.lastActedSignature = decision.signature;
                  autopilotGuard.lastActedAt = now;
                  autopilotRunning = false;
                }
              }

              process.stdout.write(
                "State rebuild (interval: " + stateIntervalMs + "ms) — " + built.context.summary + " | Plan: " + p.summary + "\n"
              );
            } else {
              process.stdout.write(
                "State rebuild (interval: " + stateIntervalMs + "ms) — " + built.context.summary + " | Plan: " + p.summary + "\n"
              );
            }

            // ── Digest refresh + Needs-you alert (read-only; never acts) ──
            try {
              const digest = buildDigest();
              writeDigest(renderDigest(digest));
              const sig = needsYouSignature(digest.needsYou);
              if (sig !== lastNeedsSignature) {
                if (digest.needsYou.length > 0) {
                  process.stdout.write("⚠️  Needs you (" + digest.needsYou.length + "):\n");
                  for (const item of digest.needsYou) {
                    process.stdout.write("   - " + item.summary + "\n");
                  }
                } else if (lastNeedsSignature !== null) {
                  process.stdout.write("✓ Needs-you queue cleared.\n");
                }
                lastNeedsSignature = sig;

                // Durable notification log (append-only; local only).
                const { added, removed } = diffNeedsYou(lastNeedsItems, digest.needsYou);
                const nowTs = new Date().toISOString();
                const records = [
                  ...added.map((i) => ({ ts: nowTs, event: "added" as const, source: i.source, summary: i.summary, detail: i.detail })),
                  ...removed.map((i) => ({ ts: nowTs, event: "resolved" as const, source: i.source, summary: i.summary, detail: i.detail })),
                ];
                appendNotifications(records);
                lastNeedsItems = digest.needsYou;
              }
            } catch (digestErr) {
              process.stderr.write("Digest refresh failed: " + (digestErr as Error).message + "\n");
            }

            // ── LLM inference (guesses only; behind config.infer.enabled) ──
            if (config.infer?.enabled === true && !inferRunning) {
              const inferCooldown = config.infer.cooldownMs ?? 300000;
              const nowMs = Date.now();
              if (lastInferAt === null || nowMs - lastInferAt >= inferCooldown) {
                inferRunning = true;
                lastInferAt = nowMs;
                // Fire-and-forget: never block the tick on a network call.
                runInference(built.context, { config })
                  .then((result) => {
                    writeInference(result);
                    if (!result.error && (result.block?.likely || result.deadline?.likely)) {
                      process.stdout.write("Infer: block=" + (result.block?.likely ? "?" : "no") + " deadline=" + (result.deadline?.likely ? "?" : "no") + " (see suggestions in report)\n");
                    }
                  })
                  .catch((e) => process.stderr.write("Infer failed: " + (e as Error).message + "\n"))
                  .finally(() => { inferRunning = false; });
              }
            }

            // ── Advisor (proactive proposals; behind config.advisor.enabled) ──
            if (config.advisor?.enabled === true && !advisorRunning) {
              const advisorCooldown = config.advisor.cooldownMs ?? 600000;
              const nowMs = Date.now();
              if (lastAdvisorAt === null || nowMs - lastAdvisorAt >= advisorCooldown) {
                advisorRunning = true;
                lastAdvisorAt = nowMs;
                runAdvisor(built.context, { config })
                  .then((result) => {
                    if (result.added.length > 0) {
                      process.stdout.write("Advisor: +" + result.added.length + " proposal(s) — review in `ui`\n");
                    }
                  })
                  .catch((e) => process.stderr.write("Advisor failed: " + (e as Error).message + "\n"))
                  .finally(() => { advisorRunning = false; });
              }
            }

            // ── Screen inference (OCR/vision suggestions; behind config.screen.ocr/vision.enabled) ──
            const screenOn = config.screen?.ocr?.enabled === true || config.screen?.vision?.enabled === true;
            if (screenOn && !screenRunning) {
              const screenCooldown = Math.min(
                config.screen?.ocr?.cooldownMs ?? 300000,
                config.screen?.vision?.cooldownMs ?? 600000,
              );
              const nowMs = Date.now();
              if (lastScreenAt === null || nowMs - lastScreenAt >= screenCooldown) {
                screenRunning = true;
                lastScreenAt = nowMs;
                setScreenActivity(true, config.screen?.ocr?.enabled ? "ocr" : "vision");
                runScreenInference(config)
                  .then((result) => {
                    writeScreenInferred(result);
                    if (result.suggestions.length > 0) {
                      process.stdout.write("Screen infer: +" + result.suggestions.length + " suggestion(s) (" + result.layer + ") — see report\n");
                    }
                  })
                  .catch((e) => process.stderr.write("Screen infer failed: " + (e as Error).message + "\n"))
                  .finally(() => { screenRunning = false; setScreenActivity(false, null); });
              }
            }
          } catch (planErr) {
            // Plan failure never crashes the daemon.
            process.stderr.write("Plan rebuild failed: " + (planErr as Error).message + "\n");
          }
        } catch (err) {
          process.stderr.write("State rebuild failed: " + (err as Error).message + "\n");
        }
      }

      // One rebuild immediately at startup.
      await runRebuild();

      // Rebuild every intervalMs.
      const rebuildTimer = setInterval(runRebuild, stateIntervalMs);

      // ── Wait for SIGINT ──────────────────────────────────────────────────
      process.on("SIGINT", async () => {
        process.stdout.write("\nStopping watchers...\n");
        clearInterval(rebuildTimer);
        await manager.stopAll();
        // Write final line to log file
        try {
          writeFileSync(logFilePath, "[stopped]\n", { flag: "a" });
        } catch {
          // Ignore log write errors.
        }
        process.stdout.write("stopped\n");
        process.exit(0);
      });

      // Keep the process alive.
      await new Promise<void>(() => {
        // This promise never resolves; we rely on SIGINT to exit.
      });
      break;
    }

    case "execute": {
      if (args.length < 2) {
        process.stderr.write("Error: execute requires <changeset.json>\n");
        process.exit(1);
      }

      const changesetPath = args[1]!;
      let rawCs: string;
      try {
        rawCs = readFileSync(changesetPath, "utf-8");
      } catch {
        process.stderr.write("Error: cannot read changeset file: " + changesetPath + "\n");
        process.exit(1);
      }

      let cs: { id: string; title: string; ops: unknown[]; test: unknown; commitMessage: string };
      try {
        cs = JSON.parse(rawCs);
      } catch {
        process.stderr.write("Error: malformed JSON in changeset file\n");
        process.exit(1);
      }

      await bootstrap();
      const config = loadConfig();
      const apply = args.includes("--apply");

      const report = applyChangeSet(cs as any, { apply, repoRoot: process.cwd(), config });
      writeReport(report);

      // Print concise summary
      process.stdout.write("mode: " + report.mode + "\n");
      process.stdout.write("ok: " + report.ok + "\n");
      for (const msg of report.messages) {
        process.stdout.write("  " + msg + "\n");
      }
      for (const op of report.plannedOps) {
        process.stdout.write(
          "  " + op.op + " " + op.path + " — " + op.effect + (op.wouldSucceed ? "" : " (BLOCKED)") + "\n"
        );
      }
      process.stdout.write("report: " + execReportPath() + "\n");

      process.exit(report.ok ? 0 : 1);
      break;
    }

    case "synth": {
      // Parse --files <csv> and --proposal <id>
      let explicitFiles: string[] | undefined;
      let proposalId: string | null = null;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--files" && i + 1 < args.length) {
          const csv = args[++i]!;
          explicitFiles = csv.split(",").map((f) => f.trim()).filter((f) => f.length > 0);
        } else if (args[i] === "--proposal" && i + 1 < args.length) {
          proposalId = args[++i]!;
        }
      }

      await bootstrap();
      const config = loadConfig();
      try {
        const report = await runSynth({
          repoRoot: process.cwd(),
          config,
          explicitFiles,
          proposalId: proposalId || undefined,
        });
        writeSynthReport(report);

        // Print concise summary
        process.stdout.write("proposal: " + (report.proposalId || "(none)") + "\n");
        process.stdout.write("synthesizer: " + (report.synthesizer || "(none)") + "\n");
        process.stdout.write("selectedFiles: " + report.selectedFiles.join(", ") + "\n");
        if (!report.changeSetWritten) {
          // Early exit (no proposal / non-actionable proposal / synthesizer failure):
          // report.messages carries the reason, and there is no changeset to point to.
          for (const m of report.messages) {
            process.stdout.write(m + "\n");
          }
          process.exit(report.ok ? 0 : 1);
        }
        process.stdout.write("validation.ok: " + report.validation.ok + "\n");
        for (const e of report.validation.errors) {
          process.stdout.write("  error: " + e + "\n");
        }
        if (report.execReport) {
          process.stdout.write("dry-run.ok: " + report.execReport.ok + "\n");
          for (const op of report.execReport.plannedOps) {
            process.stdout.write("  " + op.op + " " + op.path + " — " + op.effect + (op.wouldSucceed ? "" : " (BLOCKED)") + "\n");
          }
        }
        process.stdout.write("changeset: " + changeSetPath() + "\n");
        process.stdout.write("review " + changeSetPath() + ", then: execute " + changeSetPath() + " --apply\n");

        process.exit(report.ok ? 0 : 1);
      } catch (err) {
        process.stderr.write("Error: " + (err as Error).message + "\n");
        process.exit(1);
      }
      break;
    }

    case "auto": {
      // Parse --apply and --files <csv>
      let apply = false;
      let explicitFiles: string[] | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--apply") {
          apply = true;
        } else if (args[i] === "--files" && i + 1 < args.length) {
          const csv = args[++i]!;
          explicitFiles = csv.split(",").map((f) => f.trim()).filter((f) => f.length > 0);
        }
      }

      await bootstrap();
      const config = loadConfig();
      try {
        const report = await runAuto({
          repoRoot: process.cwd(),
          config,
          apply,
          explicitFiles,
        });
        writeAutoReport(report);

        // Print concise summary
        process.stdout.write("stage: " + report.stage + "\n");
        process.stdout.write("ok: " + report.ok + "\n");
        process.stdout.write("needsHuman: " + report.needsHuman + "\n");
        if (report.topAction) {
          process.stdout.write(
            "topAction: " + report.topAction.kind + " (" + report.topAction.disposition + ")\n"
          );
        }
        if (report.proposalId) {
          process.stdout.write("proposal: " + report.proposalId + "\n");
        }
        if (report.validationOk !== null) {
          process.stdout.write("validationOk: " + report.validationOk + "\n");
        }
        if (report.dryRunOk !== null) {
          process.stdout.write("dryRunOk: " + report.dryRunOk + "\n");
        }
        if (report.applied) {
          process.stdout.write("applied: true\n");
          process.stdout.write("branch: " + report.branch + "\n");
          process.stdout.write("commit: " + report.commitSha + "\n");
          process.stdout.write("testPassed: " + (report.testPassed ?? "n/a") + "\n");
        }
        for (const m of report.messages) {
          process.stdout.write("  " + m + "\n");
        }
        process.stdout.write("report: " + autoReportPath() + "\n");

        process.exit(report.ok ? 0 : 1);
      } catch (err) {
        process.stderr.write("Error: " + (err as Error).message + "\n");
        process.exit(1);
      }
      break;
    }

    case "report": {
      await bootstrap();
      try {
        // Freshen state + plan from the event log first (deterministic, no LLM),
        // so `report` reflects the latest events even without a running daemon.
        // If this fails (e.g. corrupt logs), fall through to a digest of whatever
        // artifacts already exist — report must always render something.
        try {
          const built = buildState();
          writeState(built);
          const p = plan(built.state, built.context);
          writePlan(p);
        } catch (refreshErr) {
          process.stderr.write(
            "Warning: could not refresh state/plan (" + (refreshErr as Error).message + "); reporting existing artifacts\n"
          );
        }
        const digest = buildDigest();
        const md = renderDigest(digest);
        writeDigest(md);
        process.stdout.write(md + "\n");
        process.stdout.write("\n(written to " + digestPath() + ")\n");
        process.exit(0);
      } catch (err) {
        process.stderr.write("Error: " + (err as Error).message + "\n");
        process.exit(1);
      }
      break;
    }

    case "notifications": {
      await bootstrap();
      const nArg = args[1] ? parseInt(args[1], 10) : 10;
      if (isNaN(nArg) || nArg < 1) {
        process.stderr.write("Error: n must be a positive integer\n");
        process.exit(1);
      }
      try {
        const all = readNotifications();
        const lastN = nArg >= all.length ? all : all.slice(all.length - nArg);
        if (lastN.length === 0) {
          process.stdout.write("No notifications yet.\n");
          process.exit(0);
        }
        for (const r of lastN) {
          process.stdout.write(r.ts + "  [" + r.event + "] " + r.source + ": " + r.summary);
          if (r.detail) {
            process.stdout.write("\n  — " + r.detail);
          }
          process.stdout.write("\n");
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write("Error: " + (err as Error).message + "\n");
        process.exit(1);
      }
      break;
    }

    case "install-hooks": {
      await bootstrap();
      const config = loadConfig();
      // Parse --test "<cmd>" (its value may contain spaces → single argv element).
      let testCommand: string | null = config.hooks?.testCommand ?? null;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--test" && i + 1 < args.length) {
          testCommand = args[++i]!;
        }
      }
      if (!testCommand || testCommand.trim() === "") {
        process.stderr.write(
          'Error: no test command. Pass --test "<cmd>" (e.g. --test "bun test") ' +
            "or set hooks.testCommand in .executive/config.json\n"
        );
        process.exit(1);
      }
      const result = installHooks({
        repoRoot: process.cwd(),
        testCommand: testCommand.trim(),
        runtimeEntry: Bun.main,
      });
      if (result.ok) {
        process.stdout.write(result.message + "\n");
        process.stdout.write("hook: " + result.path + "\n");
        process.exit(0);
      } else {
        process.stderr.write("install-hooks failed: " + result.message + "\n");
        process.exit(1);
      }
      break;
    }

    case "infer": {
      await bootstrap();
      try {
        const config = loadConfig();
        const built = buildState();
        writeState(built);
        const result = await runInference(built.context, { config });
        writeInference(result);
        process.stdout.write("backend: " + result.backend + "\n");
        if (result.error) {
          process.stdout.write("error: " + result.error + "\n");
        } else {
          process.stdout.write(
            "block: " + (result.block?.likely ? "LIKELY — " + result.block.reason : "no") + "\n"
          );
          process.stdout.write(
            "deadline: " +
              (result.deadline?.likely
                ? "LIKELY — " + (result.deadline.date ? result.deadline.date + " " : "") + result.deadline.note
                : "no") +
              "\n"
          );
        }
        process.stdout.write("(written to " + inferredPath() + ")\n");
        process.stdout.write("These are GUESSES — confirm with `emit` or the dashboard buttons.\n");
        process.exit(0);
      } catch (err) {
        process.stderr.write("Error: " + (err as Error).message + "\n");
        process.exit(1);
      }
      break;
    }

    case "capture": {
      const note = args.slice(1).join(" ").trim();
      if (!note) {
        process.stderr.write('Error: capture requires a note, e.g. capture "blocked on the Stripe webhook again"\n');
        process.exit(1);
      }
      await bootstrap();
      const ev = await append({ source: "system", type: "system.note", data: { msg: note, via: "text" } });
      process.stdout.write("captured (#" + ev.seq + "). The Advisor will factor it in.\n");
      process.exit(0);
      break;
    }

    case "download-model": {
      await bootstrap();
      const config = loadConfig();
      const modelId = args[1] || config.transcribe?.wasmModel || "Xenova/whisper-base";
      process.stdout.write("Downloading browser-wasm assets for " + modelId + " (one-time)…\n");
      const { downloadWasmAssets } = await import("./ui/models.js");
      const result = await downloadWasmAssets(modelId, { onLog: (l) => process.stdout.write(l + "\n") });
      if (result.ok) {
        process.stdout.write(
          "Done: " + result.files + " new file(s), " + Math.round(result.bytes / 1e6) + " MB. " +
            "Set the dashboard transcription mode to browser-wasm to use it offline.\n",
        );
        process.exit(0);
      } else {
        process.stderr.write("Error: " + result.error + "\n");
        process.exit(1);
      }
      break;
    }

    case "propose": {
      await bootstrap();
      try {
        const config = loadConfig();
        const built = buildState();
        writeState(built);
        const result = await runAdvisor(built.context, { config });
        if (result.error) {
          process.stdout.write("advisor error: " + result.error + "\n");
          process.exit(1);
        }
        if (result.added.length === 0) {
          process.stdout.write("No new proposals right now.\n");
        } else {
          process.stdout.write("Added " + result.added.length + " proposal(s):\n");
          for (const p of result.added) {
            process.stdout.write("  • [" + p.category + "] " + p.title + "\n");
          }
        }
        process.stdout.write("Review + approve them in `proposals` or the dashboard (`ui`).\n");
        process.exit(0);
      } catch (err) {
        process.stderr.write("Error: " + (err as Error).message + "\n");
        process.exit(1);
      }
      break;
    }

    case "proposals": {
      await bootstrap();
      const items = pending(readStore());
      if (items.length === 0) {
        process.stdout.write("No pending proposals. Run `propose` to get some.\n");
        process.exit(0);
      }
      for (const p of items) {
        process.stdout.write(
          "\n[" + p.category + "] " + p.title + (p.executable ? "  [executable]" : "") +
            "  (" + p.id.slice(0, 8) + ")\n",
        );
        process.stdout.write("  " + p.detail + "\n");
        process.stdout.write("  → " + p.action + "\n");
      }
      process.stdout.write("\nApprove/dismiss via `approve <id>` / `dismiss <id>`, or the dashboard (`ui`).\n");
      process.exit(0);
      break;
    }

    case "approve": {
      if (args.length < 2) {
        process.stderr.write("Error: approve requires <proposalId>\n");
        process.exit(1);
      }
      const idArg = args[1]!;
      let forceApply = false;
      let note: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--apply") {
          forceApply = true;
        } else if (args[i] === "--note" && i + 1 < args.length) {
          note = args[++i];
        }
      }
      await bootstrap();
      const config = loadConfig();
      const store = readStore();
      const match = store.items.find((p) => p.id === idArg || p.id.startsWith(idArg));
      if (!match) {
        process.stderr.write("Error: no proposal found matching id: " + idArg + "\n");
        process.exit(1);
      }
      // --apply forces the apply path for THIS approval only, even if config.advisor.applyOnApprove is false.
      const effectiveConfig = forceApply
        ? { ...config, advisor: { ...config.advisor, applyOnApprove: true } }
        : config;
      const p = await decideProposal(match.id, "approve", note ? { note } : undefined, effectiveConfig);
      if (!p) {
        process.stderr.write("Error: proposal not found\n");
        process.exit(1);
      }
      process.stdout.write("Approved: " + p.title + "\n");
      if (p.executable === true && p.execution) {
        process.stdout.write("  executable: yes\n");
        process.stdout.write("  valid: " + p.execution.valid + "\n");
        process.stdout.write("  applied: " + p.execution.applied + "\n");
        if (p.execution.branch) process.stdout.write("  branch: " + p.execution.branch + "\n");
        if (p.execution.testPassed !== null) process.stdout.write("  testPassed: " + p.execution.testPassed + "\n");
        process.stdout.write("  " + p.execution.message + "\n");
      }
      process.exit(0);
      break;
    }

    case "dismiss": {
      if (args.length < 2) {
        process.stderr.write("Error: dismiss requires <proposalId>\n");
        process.exit(1);
      }
      const idArg = args[1]!;
      await bootstrap();
      const store = readStore();
      const match = store.items.find((p) => p.id === idArg || p.id.startsWith(idArg));
      if (!match) {
        process.stderr.write("Error: no proposal found matching id: " + idArg + "\n");
        process.exit(1);
      }
      const p = await decideProposal(match.id, "reject");
      process.stdout.write("Dismissed: " + (p?.title ?? idArg) + "\n");
      process.exit(0);
      break;
    }

    case "ui": {
      await bootstrap();
      let port = 4317;
      let noWatch = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--port" && i + 1 < args.length) {
          const parsed = parseInt(args[++i]!, 10);
          if (!isNaN(parsed) && parsed > 0) port = parsed;
        } else if (args[i] === "--no-watch") {
          noWatch = true;
        }
      }
      try {
        // Start the git + fs watchers so activity is captured while the dashboard
        // is open (the dashboard itself rebuilds state on each poll). --no-watch skips this.
        let manager: WatcherManager | null = null;
        if (!noWatch) {
          const config = loadConfig();
          const bus = new EventBus();
          attachStoreSink(bus, () => {});
          const { watchers } = buildWatchers(config);
          manager = new WatcherManager(bus, watchers);
          await manager.startAll();
        }

        const server = startUiServer({ port });

        // Periodic screen inference (mirrors the `watch` daemon's wiring — see runRebuild —
        // but `ui` is its own process, so it needs its own trigger for the live "reading
        // screen" indicator to work when the owner runs `ui` alone, without `watch`).
        let uiScreenRunning = false;
        let uiLastScreenAt: number | null = null;
        const screenTimer = setInterval(() => {
          const cfg = loadConfig(); // re-read in case Settings changed it via the dashboard
          const screenOn = cfg.screen?.ocr?.enabled === true || cfg.screen?.vision?.enabled === true;
          if (!screenOn || uiScreenRunning) return;
          const cooldown = Math.min(cfg.screen?.ocr?.cooldownMs ?? 300000, cfg.screen?.vision?.cooldownMs ?? 600000);
          const nowMs = Date.now();
          if (uiLastScreenAt !== null && nowMs - uiLastScreenAt < cooldown) return;
          uiScreenRunning = true;
          uiLastScreenAt = nowMs;
          setScreenActivity(true, cfg.screen?.ocr?.enabled ? "ocr" : "vision");
          runScreenInference(cfg)
            .then((result) => writeScreenInferred(result))
            .catch((e) => process.stderr.write("Screen infer failed: " + (e as Error).message + "\n"))
            .finally(() => { uiScreenRunning = false; setScreenActivity(false, null); });
        }, 30000);

        process.stdout.write("ExecutiveOS dashboard: http://localhost:" + server.port + "\n");
        process.stdout.write(manager ? "Watching git + files for activity.\n" : "Dashboard only (--no-watch).\n");
        process.stdout.write("(Ctrl-C to stop)\n");
        process.on("SIGINT", async () => {
          clearInterval(screenTimer);
          server.stop();
          if (manager) await manager.stopAll();
          process.stdout.write("\nstopped\n");
          process.exit(0);
        });
        await new Promise<void>(() => {
          // Keep alive; rely on SIGINT to exit.
        });
      } catch (err) {
        process.stderr.write("Error: " + (err as Error).message + "\n");
        process.exit(1);
      }
      break;
    }

    default:
      process.stderr.write('Error: unknown command "' + command + '"\n');
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write("Error: " + err.message + "\n");
  process.exit(1);
});
