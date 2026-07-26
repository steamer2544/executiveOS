// Local web dashboard server (Phase 18).
// Binds to 127.0.0.1 only. Reads .executive/ state and lets you emit the
// signals a watcher can't sense (block/unblock/deadline/task) via buttons.
// Deterministic, no LLM. Reuses the existing State/Planner/Digest/EventStore.

import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildState, writeState } from "../state/builder.js";
import { plan, writePlan } from "../planner/planner.js";
import { buildDigest } from "../report/digest.js";
import { append } from "../events/store.js";
import { loadConfig, llmTimeoutMs, updateTranscribeConfig, updateScreenConfig, updateAutonomyConfig, readAutonomyConfig, updateFileOutputConfig, readFileOutputConfig, TRANSCRIBE_PRESETS } from "../config.js";
import { modelsDir, vendorDir } from "../paths.js";
import { readStore, pending } from "../advisor/store.js";
import { runAdvisor, decideProposal } from "../advisor/advisor.js";
import { downloadWasmAssets, wasmAssetsStatus } from "./models.js";
import { judgeNote } from "../capture/note.js";
import { runTurn, resumeTurn } from "../agent/loop.js";
import { chatErrorMessage } from "../agent/protocol.js";
import { markNudgeAnswered } from "../proactive/proactive.js";
import { readConversation, readPending, clearConversation, clearPending } from "../agent/session.js";
import type { ConfirmDecision } from "../agent/types.js";
import { renderPage } from "./page.js";

/** Live "is a screen capture in flight" flag, set by the periodic screen-infer trigger in
 *  src/index.ts (case "ui" and case "watch" both call this — only the "ui" process's own
 *  calls are observable here, since "watch" runs as a separate OS process). Read by
 *  GET /api/state so the dashboard can show a "🔴 reading screen" indicator. */
export const screenActivity: { active: boolean; layer: "ocr" | "vision" | null } = { active: false, layer: null };
export function setScreenActivity(active: boolean, layer: "ocr" | "vision" | null): void {
  screenActivity.active = active;
  screenActivity.layer = layer;
}

/** Content types for the locally-served browser-wasm assets. */
const STATIC_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

// Model download runs in the background: the payload is ~81MB, far longer than any
// legal idleTimeout. POST kicks it off, GET /api/transcribe/status reports progress.
let downloadRunning = false;
let downloadResult: unknown = null;
let downloadError: string | null = null;

/** Serve a file from `root` for a URL like `/vendor/<rel>`, with path-safety (no `..` escape). */
function serveStatic(root: string, rel: string): Response {
  let target: string;
  try {
    const clean = decodeURIComponent(rel).replace(/^\/+/, "");
    target = resolve(root, clean);
    const base = resolve(root);
    if (target !== base && !target.startsWith(base + "/") && !target.startsWith(base + "\\")) {
      return new Response("forbidden", { status: 403 });
    }
  } catch {
    return new Response("bad path", { status: 400 });
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    return new Response("not found", { status: 404 });
  }
  const dot = target.lastIndexOf(".");
  const ext = dot >= 0 ? target.slice(dot).toLowerCase() : "";
  const type = STATIC_TYPES[ext] ?? "application/octet-stream";
  return new Response(readFileSync(target), { headers: { "content-type": type } });
}

/** The only system event types the GUI is allowed to emit (safe, human-in-head signals). */
const ALLOWED_EMIT_TYPES = new Set([
  "system.blocked",
  "system.unblocked",
  "system.task",
  "system.test_result",
  "system.note", // dictated/typed captures from the dashboard's listening mode
]);

/** Build the current digest, freshening state + plan first (deterministic). */
function currentState(): { digest: ReturnType<typeof buildDigest>; summary: string } {
  const built = buildState();
  writeState(built);
  const p = plan(built.state, built.context);
  writePlan(p);
  const digest = buildDigest();
  return { digest, summary: built.context.summary };
}

export interface UiServerOptions {
  port: number;
  hostname?: string; // default 127.0.0.1 (localhost only)
}

/** Start the dashboard server. Returns the Bun Server (call .stop() to close). */
export function startUiServer(opts: UiServerOptions) {
  // The server must outlive the slowest handler. /api/propose awaits the LLM gateway,
  // whose client timeout floors at llmTimeoutMs (120s), so an equal server timeout races
  // it. Bun caps idleTimeout at 255s.
  let idleTimeout = 150;
  try {
    idleTimeout = Math.min(255, Math.ceil(llmTimeoutMs(loadConfig()) / 1000) + 30);
  } catch {
    // unreadable config at startup must not stop the dashboard from serving
  }
  return Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/") {
        return new Response(renderPage(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        try {
          const cfg = loadConfig();
          // The transcribe block carries NO secret — the real key lives only in process.env[apiKeyEnv],
          // never in config — so it is safe to hand the whole block to the local settings editor.
          return Response.json({
            capture: cfg.capture,
            transcribe: cfg.transcribe,
            presets: TRANSCRIBE_PRESETS,
            screen: cfg.screen ?? null,
            // Same reasoning as transcribe: the agent block holds no secret (it reuses
            // config.worker, whose key lives only in process.env[apiKeyEnv]).
            agent: {
              enabled: cfg.agent?.enabled === true,
              speak: cfg.agent?.speak === true,
              trustedTools: cfg.agent?.trustedTools ?? [],
            },
            // Gates the dashboard can switch. autopilotApply is reported but not settable —
            // see updateAutonomyConfig for why arming repo-writing autonomy stays a file edit.
            autonomy: readAutonomyConfig(cfg),
            // Where save_file may write, and whether the two loosening switches are on.
            // Paths only — nothing here is a secret.
            fileOutput: readFileOutputConfig(cfg),
          });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/autonomy") {
        try {
          const body = (await req.json()) as Record<string, unknown>;
          return Response.json({ ok: true, autonomy: updateAutonomyConfig(body) });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 400 });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/file-output") {
        try {
          const body = (await req.json()) as Record<string, unknown>;
          return Response.json({ ok: true, fileOutput: updateFileOutputConfig(body) });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 400 });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/settings") {
        try {
          const body = (await req.json()) as { transcribe?: Record<string, unknown>; screen?: Record<string, unknown> };
          if ((!body.transcribe || typeof body.transcribe !== "object") && (!body.screen || typeof body.screen !== "object")) {
            return Response.json({ ok: false, error: "need { transcribe: {...} } and/or { screen: {...} }" }, { status: 400 });
          }
          const result: { ok: true; transcribe?: unknown; screen?: unknown } = { ok: true };
          if (body.transcribe && typeof body.transcribe === "object") {
            result.transcribe = updateTranscribeConfig(body.transcribe);
          }
          if (body.screen && typeof body.screen === "object") {
            result.screen = updateScreenConfig(body.screen);
          }
          return Response.json(result);
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
        }
      }

      if (req.method === "GET" && url.pathname === "/api/transcribe/status") {
        try {
          const cfg = loadConfig();
          return Response.json({
            ...wasmAssetsStatus(cfg.transcribe?.wasmModel ?? "Xenova/whisper-base"),
            download: { running: downloadRunning, result: downloadResult, error: downloadError },
          });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/transcribe/download") {
        try {
          const cfg = loadConfig();
          const body = (await req.json().catch(() => ({}))) as { model?: string };
          const modelId = body.model || cfg.transcribe?.wasmModel || "Xenova/whisper-base";
          if (downloadRunning) {
            return Response.json({ started: false, running: true }, { status: 200 });
          }
          downloadRunning = true;
          downloadResult = null;
          downloadError = null;
          downloadWasmAssets(modelId)
            .then((r) => { downloadResult = r; })
            .catch((e) => { downloadError = (e as Error).message; })
            .finally(() => { downloadRunning = false; });
          return Response.json({ started: true, running: true }, { status: 202 });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      // Locally-served browser-wasm assets (transformers.js + model files). Path-safety enforced.
      if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
        return serveStatic(vendorDir(), url.pathname.slice("/vendor/".length));
      }
      if (req.method === "GET" && url.pathname.startsWith("/models/")) {
        return serveStatic(modelsDir(), url.pathname.slice("/models/".length));
      }

      if (req.method === "POST" && url.pathname === "/api/transcribe") {
        try {
          const cfg = loadConfig();
          const t = cfg.transcribe;
          if (t?.mode !== "whisper-api" || !t.baseUrl) {
            return Response.json({ ok: false, error: "transcription not configured" }, { status: 400 });
          }
          const audio = await req.blob();
          const key = t.apiKeyEnv ? (process.env[t.apiKeyEnv] ?? "") : "";
          const language = url.searchParams.get("language") || t.language || "";
          const form = new FormData();
          form.append("file", audio, "audio.webm");
          form.append("model", t.model ?? "whisper-1");
          if (language) form.append("language", language);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 60000);
          try {
            const res = await fetch(t.baseUrl.replace(/\/+$/, "") + "/v1/audio/transcriptions", {
              method: "POST",
              headers: key ? { Authorization: "Bearer " + key } : {},
              body: form,
              signal: controller.signal,
            });
            if (!res.ok) {
              const bt = await res.text();
              return Response.json({ ok: false, error: "transcribe HTTP " + res.status + ": " + bt.slice(0, 200) }, { status: 502 });
            }
            const j = (await res.json()) as { text?: string };
            return Response.json({ ok: true, text: (j.text ?? "").trim() });
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
        }
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        try {
          return Response.json({ ...currentState(), screenActivity });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/emit") {
        try {
          const body = (await req.json()) as { type?: string; data?: Record<string, unknown> };
          const type = body.type ?? "";
          const data = body.data ?? {};
          if (!ALLOWED_EMIT_TYPES.has(type)) {
            return Response.json({ ok: false, error: "type not allowed: " + type }, { status: 400 });
          }
          // Dictated notes pass a low-signal filter — a live mic transcribes counting and
          // mumbles, which would otherwise reach the Advisor as if they were thoughts.
          // Not an error for the caller: the note is simply not recorded.
          if (type === "system.note" && data.via === "voice") {
            const verdict = judgeNote(typeof data.msg === "string" ? data.msg : "");
            if (!verdict.keep) return Response.json({ ok: true, skipped: true, reason: verdict.reason });
          }
          const event = await append({ source: "system", type, data });
          return Response.json({ ok: true, seq: event.seq });
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
        }
      }

      // ── Proposals (the Advisor queue) ────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/proposals") {
        try {
          return Response.json({ proposals: pending(readStore()) });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/propose") {
        // Generate fresh proposals (LLM — may take a while).
        try {
          const built = buildState();
          writeState(built);
          const result = await runAdvisor(built.context, { config: loadConfig() });
          return Response.json({ ok: result.error === null, added: result.added.length, error: result.error });
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/proposal/decide") {
        try {
          const body = (await req.json()) as { id?: string; decision?: string; action?: string; note?: string };
          if (!body.id || (body.decision !== "approve" && body.decision !== "reject")) {
            return Response.json({ ok: false, error: "need { id, decision: approve|reject }" }, { status: 400 });
          }
          const p = await decideProposal(
            body.id,
            body.decision,
            { action: body.action, note: body.note },
            loadConfig(),
          );
          if (!p) return Response.json({ ok: false, error: "unknown proposal id" }, { status: 404 });
          return Response.json({ ok: true, proposal: p });
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
        }
      }

      // ── Chat with the agent (Phase 35) ──────────────────────────────────
      // Off unless config.agent.enabled. Every route reloads config so the
      // Autonomy toggle takes effect without restarting the dashboard.
      if (url.pathname.startsWith("/api/chat")) {
        const config = loadConfig();
        if (config.agent?.enabled !== true) {
          return Response.json({ ok: false, error: "agent is off" }, { status: 403 });
        }

        if (req.method === "GET" && url.pathname === "/api/chat/history") {
          const n = Math.min(Math.max(Number(url.searchParams.get("n")) || 50, 1), 500);
          const all = readConversation();
          return Response.json({ messages: all.slice(-n), pending: readPending() });
        }

        if (req.method === "POST" && url.pathname === "/api/chat") {
          try {
            const body = (await req.json()) as { message?: string; via?: "text" | "voice" };
            const message = (body.message ?? "").trim();
            if (!message) return Response.json({ ok: false, error: "empty message" }, { status: 400 });
            // Answering here closes the loop on any open proactive nudge too — the
            // owner may reply in the dashboard to a nudge Discord delivered. Derived
            // from the log, so it works across processes.
            markNudgeAnswered();
            const turn = await runTurn(message, { config, via: body.via ?? "text" });
            return Response.json({ ok: true, ...turn });
          } catch (err) {
            return Response.json({ ok: false, error: chatErrorMessage(err) }, { status: 500 });
          }
        }

        if (req.method === "POST" && url.pathname === "/api/chat/confirm") {
          try {
            const body = (await req.json()) as { pendingId?: string; decision?: ConfirmDecision };
            const d = body.decision;
            if (!body.pendingId || (d !== "run" && d !== "trust" && d !== "trust_session" && d !== "no")) {
              return Response.json(
                { ok: false, error: "need { pendingId, decision: run|trust|trust_session|no }" },
                { status: 400 },
              );
            }
            const turn = await resumeTurn(body.pendingId, d, { config });
            return Response.json({ ok: true, ...turn });
          } catch (err) {
            return Response.json({ ok: false, error: chatErrorMessage(err) }, { status: 500 });
          }
        }

        if (req.method === "POST" && url.pathname === "/api/chat/clear") {
          const archived = clearConversation();
          clearPending();
          return Response.json({ ok: true, archived });
        }
      }

      return new Response("not found", { status: 404 });
    },
  });
}
