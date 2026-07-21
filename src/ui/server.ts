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
import { loadConfig, updateTranscribeConfig, TRANSCRIBE_PRESETS } from "../config.js";
import { modelsDir, vendorDir } from "../paths.js";
import { readStore, pending } from "../advisor/store.js";
import { runAdvisor, decideProposal } from "../advisor/advisor.js";
import { downloadWasmAssets, wasmAssetsStatus } from "./models.js";
import { renderPage } from "./page.js";

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
  return Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
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
          return Response.json({ capture: cfg.capture, transcribe: cfg.transcribe, presets: TRANSCRIBE_PRESETS });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/settings") {
        try {
          const body = (await req.json()) as { transcribe?: Record<string, unknown> };
          if (!body.transcribe || typeof body.transcribe !== "object") {
            return Response.json({ ok: false, error: "need { transcribe: {...} }" }, { status: 400 });
          }
          const transcribe = updateTranscribeConfig(body.transcribe);
          return Response.json({ ok: true, transcribe });
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
        }
      }

      if (req.method === "GET" && url.pathname === "/api/transcribe/status") {
        try {
          const cfg = loadConfig();
          return Response.json(wasmAssetsStatus(cfg.transcribe?.wasmModel ?? "Xenova/whisper-base"));
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/transcribe/download") {
        try {
          const cfg = loadConfig();
          const body = (await req.json().catch(() => ({}))) as { model?: string };
          const modelId = body.model || cfg.transcribe?.wasmModel || "Xenova/whisper-base";
          const result = await downloadWasmAssets(modelId);
          return Response.json(result, { status: result.ok ? 200 : 502 });
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
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
          return Response.json(currentState());
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
          const p = decideProposal(body.id, body.decision, { action: body.action, note: body.note });
          if (!p) return Response.json({ ok: false, error: "unknown proposal id" }, { status: 404 });
          return Response.json({ ok: true, proposal: p });
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
        }
      }

      return new Response("not found", { status: 404 });
    },
  });
}
