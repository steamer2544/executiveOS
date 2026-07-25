import {
  readFileSync,
  appendFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import type { EventSource, ExecEvent } from "./types.js";
import type { EventBackend } from "./backend.js";
import { ALL_SOURCES } from "./backend.js";
import { eventLogPath, eventsDir } from "../paths.js";
import { renameOverwrite } from "../fs-atomic.js";

/**
 * JSONL-backed EventBackend. Behaves byte-identically to today's store.ts logic.
 */
export function createJsonlBackend(): EventBackend {
  return {
    init() {
      const dir = eventsDir();
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      for (const source of ALL_SOURCES) {
        const path = eventLogPath(source);
        if (!existsSync(path)) {
          writeFileSync(path, "");
        }
      }
    },

    append(event: ExecEvent): void {
      const source = event.source;
      ensureLogExists(source);
      const line = JSON.stringify(event) + "\n";
      appendFileSync(eventLogPath(source), line);
    },

    read(source: EventSource): ExecEvent[] {
      const path = eventLogPath(source);
      if (!existsSync(path)) {
        return [];
      }

      const raw = readFileSync(path, "utf-8");
      const lines = raw.split("\n");
      const events: ExecEvent[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.trim() === "") continue;

        try {
          const event = JSON.parse(line) as ExecEvent;
          if (event.seq === undefined) {
            event.seq = 0;
          }
          events.push(event);
        } catch {
          process.stderr.write(
            `Warning: skipping corrupt line ${i + 1} in ${path}\n`,
          );
        }
      }

      return events;
    },

    tail(n: number, source?: EventSource): ExecEvent[] {
      if (source) {
        const events = this.read(source);
        events.sort((a, b) =>
          a.seq - b.seq || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0),
        );
        return events.slice(-n);
      }

      const all: ExecEvent[] = [];
      for (const src of ALL_SOURCES) {
        const events = this.read(src);
        all.push(...events);
      }

      all.sort((a, b) =>
        a.seq - b.seq || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0),
      );

      return all.slice(-n);
    },

    backupSources(destDir: string, sources: EventSource[]): string[] {
      const written: string[] = [];
      for (const source of sources) {
        const src = eventLogPath(source);
        if (!existsSync(src)) continue;
        const dest = destDir + "/" + source + ".jsonl";
        copyFileSync(src, dest);
        written.push(dest);
      }
      return written;
    },

    replaceAll(source: EventSource, events: ExecEvent[]): void {
      const path = eventLogPath(source);
      if (!existsSync(path)) {
        return; // no-op if log file does not exist
      }

      const tmp = path + "." + randomUUID();
      if (events.length > 0) {
        const content = events.map((e) => JSON.stringify(e) + "\n").join("");
        writeFileSync(tmp, content);
      } else {
        writeFileSync(tmp, "");
      }
      renameOverwrite(tmp, path);
    },
  };
}

/** Ensure the directory and jsonl file for a source exist. */
function ensureLogExists(source: EventSource): void {
  const dir = eventsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = eventLogPath(source);
  if (!existsSync(path)) {
    writeFileSync(path, "");
  }
}
