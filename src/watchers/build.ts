// Build the Watcher array from config — multi-repo or legacy single-repo path.

import type { Config } from "../config.js";
import type { Watcher } from "./index.js";
import { createGitWatcher } from "./git.js";
import { createFsWatcher } from "./fs.js";

/** Result of building watchers from config. */
export function buildWatchers(config: Config): { watchers: Watcher[]; activeNames: string[] } {
  const watchers: Watcher[] = [];
  const activeNames: string[] = [];

  // Multi-repo mode: repos array present and non-empty is authoritative.
  const repos = config.watch?.repos;
  if (repos && repos.length > 0) {
    for (const entry of repos) {
      watchers.push(
        createGitWatcher({ repoPath: entry.path, pollMs: entry.pollMs ?? 5000 })
      );
      activeNames.push("git:" + entry.name);

      if (entry.watchFiles !== false) {
        watchers.push(
          createFsWatcher({
            paths: entry.filePaths ?? [entry.path + "/src"],
            debounceMs: entry.fileDebounceMs ?? 300,
            repo: entry.name,
          })
        );
        activeNames.push("fs:" + entry.name);
      }
    }
    return { watchers, activeNames };
  }

  // Legacy single-repo path — matches src/index.ts "watch" case exactly.
  // Only enter legacy path when watch block actually exists (no watch block → empty).
  const watchBlock = config.watch;
  if (!watchBlock) {
    return { watchers, activeNames };
  }
  const gitConfig = watchBlock.git ?? {};
  const fsConfig = watchBlock.fs ?? {};

  if (gitConfig.enabled !== false) {
    watchers.push(
      createGitWatcher({ repoPath: gitConfig.repoPath ?? process.cwd(), pollMs: gitConfig.pollMs ?? 5000 })
    );
    activeNames.push("git");
  }

  if (fsConfig.enabled !== false) {
    watchers.push(
      createFsWatcher({ paths: fsConfig.paths ?? [process.cwd() + "/src"], debounceMs: fsConfig.debounceMs ?? 300 })
    );
    activeNames.push("fs");
  }

  return { watchers, activeNames };
}
