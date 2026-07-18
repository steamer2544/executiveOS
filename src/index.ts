// CLI entry point for ExecutiveOS.
// Parse process.argv hand-rolled (no CLI framework).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { bootstrap } from "./bootstrap.js";
import { append, read, tail } from "./events/store.js";
import type { EventSource } from "./events/types.js";
import { isValidType } from "./events/types.js";
import { execRoot, logsDir, statePath, contextPath, planPath, proposalPath, execReportPath } from "./paths.js";
import { EventBus } from "./bus.js";
import { attachStoreSink } from "./sink.js";
import { WatcherManager } from "./watchers/index.js";
import { createGitWatcher } from "./watchers/git.js";
import { createFsWatcher } from "./watchers/fs.js";
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

const VALID_SOURCES: EventSource[] = ["git", "terminal", "editor", "system"];

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
  --help                                        Show this help

Sources: git, terminal, editor, system

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
      const watchers = [];
      const activeNames: string[] = [];

      const watchConfig = config.watch ?? { git: {}, fs: {} };
      const gitConfig = watchConfig.git ?? {};
      const fsConfig = watchConfig.fs ?? {};

      if (gitConfig.enabled !== false) {
        const watcher = createGitWatcher({
          repoPath: gitConfig.repoPath ?? process.cwd(),
          pollMs: gitConfig.pollMs ?? 5000,
        });
        watchers.push(watcher);
        activeNames.push("git");
      }

      if (fsConfig.enabled !== false) {
        const watcher = createFsWatcher({
          paths: fsConfig.paths ?? [process.cwd() + "/src"],
          debounceMs: fsConfig.debounceMs ?? 300,
        });
        watchers.push(watcher);
        activeNames.push("fs");
      }

      const manager = new WatcherManager(bus, watchers);
      await manager.startAll();

      process.stdout.write("ExecutiveOS watch started. Active watchers: " + activeNames.join(", ") + "\n");
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
