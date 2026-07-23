// Atomic-write helpers shared by every module that persists JSON to .executive/.
//
// Windows trap: renameSync() onto an EXISTING destination intermittently fails with
// EPERM/EBUSY/EACCES, because Windows refuses to replace a file while another handle
// is open on it and antivirus / the search indexer opens a file for a few ms right
// after it is written. The lock is measured in milliseconds, so a short synchronous
// backoff clears it. Anything that is NOT one of those three codes is a real error
// (a genuine second writer, a missing temp file, a bad path) and is rethrown at once.

import { renameSync, unlinkSync } from "node:fs";

/** Injection seam — real fs by default, replaced in tests to exercise the retry loop. */
export interface RenameIo {
  rename(from: string, to: string): void;
  unlink(path: string): void;
  sleep(ms: number): void;
}

export const RETRYABLE_RENAME_CODES = ["EPERM", "EBUSY", "EACCES"] as const;

/** Block the current thread for `ms`. Atomics.wait needs a SharedArrayBuffer view. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const defaultIo: RenameIo = { rename: renameSync, unlink: unlinkSync, sleep: sleepSync };

/**
 * rename() onto an existing file, tolerating a transient Windows EPERM/EBUSY/EACCES.
 *
 * Retries with a 5,10,15… ms backoff (7 sleeps = 140 ms total at the default of 8
 * attempts). On a non-retryable error, or once the attempts are exhausted, the temp
 * file is removed (best effort) and the ORIGINAL error is rethrown — so a genuine
 * second writer still surfaces loudly instead of being papered over.
 *
 * NOTE: the backoff blocks the calling thread. In the `ui` daemon that means the HTTP
 * server stops accepting requests for up to 140 ms — acceptable on an exceptional path,
 * and far better than losing the write.
 */
export function renameOverwrite(
  from: string,
  to: string,
  attempts = 8,
  io: RenameIo = defaultIo
): void {
  for (let i = 0; ; i++) {
    try {
      io.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = (RETRYABLE_RENAME_CODES as readonly string[]).includes(code ?? "");
      if (!retryable || i >= attempts - 1) {
        try {
          io.unlink(from);
        } catch {
          // best effort: never mask the original failure with a cleanup error
        }
        throw err;
      }
      io.sleep(5 * (i + 1));
    }
  }
}
