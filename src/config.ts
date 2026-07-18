// Load and validate config.json from .executive/.

import { readFileSync } from "node:fs";
import { configPath } from "./paths.js";

export interface Config {
  /** Config schema version (always 1 for Phase 1). */
  version: 1;
  /** ISO timestamp set once at init time. */
  createdAt: string;
  /** IANA timezone identifier. */
  timezone: string;
  /** Watcher configuration (defaults applied when absent). */
  watch?: {
    git: {
      enabled?: boolean;
      repoPath?: string;
      pollMs?: number;
    };
    fs: {
      enabled?: boolean;
      paths?: string[];
      debounceMs?: number;
    };
  };
  /** State builder configuration (defaults applied when absent). */
  state?: {
    intervalMs?: number;
  };
  /** Worker (LLM) configuration (defaults applied when absent). */
  worker?: {
    backend?: "mock" | "anthropic"; // which Worker to build
    baseUrl?: string; // Anthropic-compatible gateway base (NO trailing /v1)
    model?: string; // model name, e.g. "qwen3.6-35b-a3b"
    apiKeyEnv?: string; // NAME of the env var holding the auth token
    maxTokens?: number; // cap on completion length
    timeoutMs?: number; // request timeout
    autoInvoke?: boolean; // if true, the watch daemon calls the Worker automatically
  };
  /** Executor configuration (defaults applied when absent). */
  executor?: {
    branchPrefix?: string; // prefix for the isolated branch; default "executive/change-"
    defaultTestCommand?: string | null; // used when a ChangeSet has test === null; default null
  };
  /** Synthesizer configuration (defaults applied when absent). */
  synth?: {
    maxFileBytes?: number; // skip any single file larger than this (token bound); default 100000
    maxFiles?: number;     // cap on number of files fed to the LLM; default 10
  };
  /** Continuous-autopilot configuration (defaults applied when absent). OFF by default. */
  autopilot?: {
    enabled?: boolean; // master switch: if true, the watch daemon runs the Autopilot each rebuild. Default false.
    apply?: boolean;   // if true (AND enabled), the daemon lets the Executor commit to an isolated branch. Default false.
    cooldownMs?: number; // minimum ms between two Autopilot runs. Default 300000 (5 min).
  };
}

/** Default configuration values. */
export function defaultConfig(): Config {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    timezone: "Asia/Bangkok",
    watch: {
      git: {
        enabled: true,
        repoPath: process.cwd(),
        pollMs: 5000,
      },
      fs: {
        enabled: true,
        paths: [process.cwd() + "/src"],
        debounceMs: 300,
      },
    },
    state: {
      intervalMs: 30000,
    },
    worker: {
      backend: "anthropic",
      baseUrl: "https://gateway.9arm.co",
      model: "qwen3.6-35b-a3b",
      apiKeyEnv: "EXECUTIVE_WORKER_KEY",
      maxTokens: 1024,
      timeoutMs: 30000,
      autoInvoke: false,
    },
    executor: {
      branchPrefix: "executive/change-",
      defaultTestCommand: null,
    },
    synth: {
      maxFileBytes: 100000,
      maxFiles: 10,
    },
    autopilot: {
      enabled: false,
      apply: false,
      cooldownMs: 300000,
    },
  };
}

/**
 * Read config.json. Merges missing watch fields with defaults so a
 * Phase 1 config (no `watch` key) still works.
 * Throws a clear error if the file is missing or if JSON is malformed.
 */
export function loadConfig(): Config {
  const cfgPath = configPath();

  let raw: string;
  try {
    raw = readFileSync(cfgPath, "utf-8");
  } catch {
    throw new Error("Config file not found. Run `executive init` first.");
  }

  if (!raw.trim()) {
    throw new Error("Config file is empty. Run `executive init` to create a valid config.");
  }

  let parsed: Config;
  try {
    parsed = JSON.parse(raw) as Config;
  } catch {
    throw new Error("Config file contains malformed JSON: " + cfgPath);
  }

  // Merge missing watch fields with defaults.
  const defaults = defaultConfig();
  if (!parsed.watch) {
    parsed.watch = defaults.watch!;
  }
  if (!parsed.watch.git) {
    parsed.watch.git = defaults.watch!.git;
  }
  if (!parsed.watch.fs) {
    parsed.watch.fs = defaults.watch!.fs;
  }

  // Fill in missing individual fields with defaults.
  parsed.watch.git.enabled = parsed.watch.git.enabled ?? defaults.watch!.git.enabled!;
  parsed.watch.git.repoPath = parsed.watch.git.repoPath ?? defaults.watch!.git.repoPath!;
  parsed.watch.git.pollMs = parsed.watch.git.pollMs ?? defaults.watch!.git.pollMs!;
  parsed.watch.fs.enabled = parsed.watch.fs.enabled ?? defaults.watch!.fs.enabled!;
  parsed.watch.fs.paths = parsed.watch.fs.paths ?? defaults.watch!.fs.paths!;
  parsed.watch.fs.debounceMs = parsed.watch.fs.debounceMs ?? defaults.watch!.fs.debounceMs!;

  // Merge missing state fields with defaults.
  if (!parsed.state) {
    parsed.state = defaults.state!;
  }
  parsed.state.intervalMs = parsed.state.intervalMs ?? defaults.state!.intervalMs!;

  // Merge missing worker fields with defaults.
  if (!parsed.worker) {
    parsed.worker = defaults.worker!;
  }
  parsed.worker.backend = parsed.worker.backend ?? defaults.worker!.backend!;
  parsed.worker.baseUrl = parsed.worker.baseUrl ?? defaults.worker!.baseUrl!;
  parsed.worker.model = parsed.worker.model ?? defaults.worker!.model!;
  parsed.worker.apiKeyEnv = parsed.worker.apiKeyEnv ?? defaults.worker!.apiKeyEnv!;
  parsed.worker.maxTokens = parsed.worker.maxTokens ?? defaults.worker!.maxTokens!;
  parsed.worker.timeoutMs = parsed.worker.timeoutMs ?? defaults.worker!.timeoutMs!;
  parsed.worker.autoInvoke = parsed.worker.autoInvoke ?? defaults.worker!.autoInvoke!;

  // Merge missing executor fields with defaults.
  if (!parsed.executor) {
    parsed.executor = defaults.executor!;
  }
  parsed.executor.branchPrefix = parsed.executor.branchPrefix ?? defaults.executor!.branchPrefix!;
  parsed.executor.defaultTestCommand =
    parsed.executor.defaultTestCommand ?? defaults.executor!.defaultTestCommand!;

  // Merge missing synth fields with defaults.
  if (!parsed.synth) {
    parsed.synth = defaults.synth!;
  }
  parsed.synth.maxFileBytes = parsed.synth.maxFileBytes ?? defaults.synth!.maxFileBytes!;
  parsed.synth.maxFiles = parsed.synth.maxFiles ?? defaults.synth!.maxFiles!;

  // Merge missing autopilot fields with defaults.
  if (!parsed.autopilot) {
    parsed.autopilot = defaults.autopilot!;
  }
  parsed.autopilot.enabled = parsed.autopilot.enabled ?? defaults.autopilot!.enabled!;
  parsed.autopilot.apply = parsed.autopilot.apply ?? defaults.autopilot!.apply!;
  parsed.autopilot.cooldownMs = parsed.autopilot.cooldownMs ?? defaults.autopilot!.cooldownMs!;

  return parsed;
}
