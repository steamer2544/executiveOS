// Dry-run plan — reads disk state, NO mutation.
// For each op, determines what would happen if applied.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ChangeSet, PlannedOp } from "./types.js";

export function planChangeSet(
  cs: ChangeSet,
  repoRoot: string
): PlannedOp[] {
  const result: PlannedOp[] = [];

  for (let i = 0; i < cs.ops.length; i++) {
    const op = cs.ops[i]!;
    const fullPath = path.resolve(repoRoot, op.path);
    const exists = existsSync(fullPath);
    const content = (op as { content?: string }).content ?? "";
    const newBytes = Buffer.byteLength(content, "utf8");

    let planned: PlannedOp;

    switch (op.op) {
      case "write": {
        if (exists) {
          const oldStat = statSync(fullPath);
          const oldBytes = oldStat.size;
          planned = {
            op: "write",
            path: op.path,
            effect: "overwrite (" + oldBytes + " -> " + newBytes + " bytes)",
            wouldSucceed: true,
          };
        } else {
          planned = {
            op: "write",
            path: op.path,
            effect: "create new file (" + newBytes + " bytes)",
            wouldSucceed: true,
          };
        }
        break;
      }

      case "create": {
        if (exists) {
          planned = {
            op: "create",
            path: op.path,
            effect: "create (blocked)",
            wouldSucceed: false,
            note: "file already exists",
          };
        } else {
          planned = {
            op: "create",
            path: op.path,
            effect: "create new file (" + newBytes + " bytes)",
            wouldSucceed: true,
          };
        }
        break;
      }

      case "delete": {
        if (!exists) {
          planned = {
            op: "delete",
            path: op.path,
            effect: "delete (blocked)",
            wouldSucceed: false,
            note: "file does not exist",
          };
        } else {
          planned = {
            op: "delete",
            path: op.path,
            effect: "delete",
            wouldSucceed: true,
          };
        }
        break;
      }

    }

    result.push(planned);
  }

  return result;
}
