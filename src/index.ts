// CLI entry point for ExecutiveOS.
// Parse process.argv hand-rolled (no CLI framework).

import { bootstrap } from "./bootstrap.js";
import { append, read, tail } from "./events/store.js";
import type { EventSource } from "./events/types.js";
import { isValidType } from "./events/types.js";
import { execRoot } from "./paths.js";

const VALID_SOURCES: EventSource[] = ["git", "terminal", "editor", "system"];

function printUsage(): void {
  process.stdout.write(`
ExecutiveOS — event-driven personal assistant runtime

Usage: bun run src/index.ts <command> [args]

Commands:
  init                                          Initialize .executive/ directory
  emit <source> <type> [json-data]              Append an event
  tail [n] [source]                             Show last n events
  --help                                        Show this help

Sources: git, terminal, editor, system

Examples:
  bun run src/index.ts init
  bun run src/index.ts emit system system.note '{"msg":"hello"}'
  bun run src/index.ts tail 5
  bun run src/index.ts tail 10 git
`);
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
      // Print the resolved .executive path
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

      // Validate source.
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

      // Validate type prefix.
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

      // Parse optional json-data.
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
