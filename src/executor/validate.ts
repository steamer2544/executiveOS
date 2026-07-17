// Validation — the safety core of the Executor.
// Pure function: no I/O, no mutation. Collects ALL errors.

import path from "node:path";
import type { ChangeSet, ValidationResult } from "./types.js";

export function validateChangeSet(
  cs: ChangeSet,
  repoRoot: string
): ValidationResult {
  const errors: string[] = [];

  // cs.id — non-empty, safe branch/file token
  if (!cs.id || typeof cs.id !== "string" || cs.id.trim().length === 0) {
    errors.push("id: must be a non-empty string");
  } else if (!/^[A-Za-z0-9._-]+$/.test(cs.id)) {
    errors.push(
      "id: contains unsafe characters (must match /^[A-Za-z0-9._-]+$/): '" +
        cs.id +
        "'"
    );
  }

  // cs.title
  if (
    !cs.title ||
    typeof cs.title !== "string" ||
    cs.title.trim().length === 0
  ) {
    errors.push("title: must be a non-empty string");
  }

  // cs.commitMessage
  if (
    !cs.commitMessage ||
    typeof cs.commitMessage !== "string" ||
    cs.commitMessage.trim().length === 0
  ) {
    errors.push("commitMessage: must be a non-empty string");
  }

  // cs.ops — non-empty array
  if (
    !Array.isArray(cs.ops) ||
    cs.ops.length === 0
  ) {
    errors.push("ops: must be a non-empty array");
  } else {
    const VALID_OPS = new Set(["write", "create", "delete"]);
    for (let i = 0; i < cs.ops.length; i++) {
      const op = cs.ops[i]!;
      const prefix = "ops[" + i + "]";

      // op type
      if (!VALID_OPS.has(op.op)) {
        errors.push(
          prefix + ".op: must be one of 'write', 'create', 'delete', got '" +
            op.op +
            "'"
        );
      }

      // op.path — non-empty
      if (!op.path || typeof op.path !== "string" || op.path.trim().length === 0) {
        errors.push(prefix + ".path: must be a non-empty string");
      } else {
        // Path safety checks
        // 1. Absolute path or Windows drive letter
        if (path.isAbsolute(op.path)) {
          errors.push(
            prefix + ".path: absolute path not allowed: '" + op.path + "'"
          );
        } else if (/^[A-Za-z]:/.test(op.path)) {
          errors.push(
            prefix +
              ".path: Windows drive letter not allowed: '" +
              op.path +
              "'"
          );
        }

        // 2. Path traversal escape (cross-platform).
        // Normalize to forward slashes, then walk segments tracking depth.
        // If depth ever goes negative, the path escapes the root.
        const norm = op.path.replace(/\\/g, "/");
        const segments = norm.split("/");
        let depth = 0;
        let escapes = false;
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i]!;
          if (seg === "..") {
            depth--;
            if (depth < 0) {
              escapes = true;
              break;
            }
          } else if (seg !== "" && seg !== ".") {
            depth++;
          }
        }
        if (escapes) {
          errors.push(
            prefix +
              ".path: escapes repo root: '" +
              op.path +
              "' (contains '..' that goes above root)"
          );
        }

        // 3. First segment must not be .git or .executive (case-insensitive)
        const firstSeg = norm.split("/")[0]!;
        const firstLow = firstSeg.toLowerCase();
        if (firstLow === ".git" || firstLow === ".executive") {
          errors.push(
            prefix +
              ".path: path under protected directory: '" +
              op.path +
              "' (segment: " +
              firstSeg +
              ")"
          );
        }
      }

      // write/create must have string content
      if ((op.op === "write" || op.op === "create") && typeof op.content !== "string") {
        errors.push(prefix + ".content: must be a string for '" + op.op + "' ops");
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
