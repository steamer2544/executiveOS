// CLI entry point for ExecutiveOS.
// Parse process.argv hand-rolled (no CLI framework).

import { existsSync, writeFileSync } from "node:fs";
import { bootstrap } from "./bootstrap.js";
import { append, read, tail } from "./events/store.js";
import type { EventSource } from "./events/types.js";
import { isValidType } from "./events/types.js";
import { execRoot, logsDir, statePath, contextPath } from "./paths.js";
import { EventBus } from "./bus.js";
import { attachStoreSink } from "./sink.js";
import { WatcherManager } from "./watchers/index.js";
import { createGitWatcher } from "./watchers/git.js";
import { createFsWatcher } from "./watchers/fs.js";
import { loadConfig } from "./config.js";
import { buildState, writeState } from "./state/builder.js";

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
  watch                                         Start the watcher daemon
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

      // ── Periodic state rebuild ───────────────────────────────────────────
      const stateIntervalMs = config.state?.intervalMs ?? 30000;

      // One rebuild immediately at startup.
      try {
        const built = buildState();
        writeState(built);
        process.stdout.write(
          "State rebuild (interval: " + stateIntervalMs + "ms) — " + built.context.summary + "\n"
        );
      } catch (err) {
        process.stderr.write("State rebuild failed at startup: " + (err as Error).message + "\n");
      }

      // Rebuild every intervalMs.
      const rebuildTimer = setInterval(() => {
        try {
          const built = buildState();
          writeState(built);
        } catch (err) {
          process.stderr.write("State rebuild failed: " + (err as Error).message + "\n");
        }
      }, stateIntervalMs);

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
