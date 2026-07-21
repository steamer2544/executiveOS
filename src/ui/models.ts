// Phase 25 — browser-wasm asset fetcher.
// Downloads, ONCE, everything the in-browser Whisper needs so it can then run 100% offline:
//   (a) the transformers.js dist bundle + onnxruntime-web .wasm into .executive/vendor/
//   (b) the HF model repo files into .executive/models/<id>/  (HF directory layout)
// The dashboard serves these from 127.0.0.1 (see server.ts), so the browser never touches the net
// at transcription time — only this one-time download does. Server-side only; not called from the page
// except via the POST /api/transcribe/download endpoint.

import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { modelsDir, vendorDir } from "../paths.js";

/** transformers.js package pinned so the served lib + wasm are a matched set. */
const VENDOR_PACKAGE = "@huggingface/transformers";
const VENDOR_VERSION = "3.7.5";

export interface DownloadResult {
  ok: boolean;
  model: string;
  files: number; // files newly written this run
  bytes: number; // bytes newly written this run
  error: string | null;
}

export interface AssetsStatus {
  libReady: boolean;   // the transformers.js bundle is present under vendor/
  modelReady: boolean; // at least the model config + one weight file is present
  vendorFiles: number;
  modelFiles: number;
}

type Logger = (line: string) => void;

/** Guard: `target` must stay inside `root` (reject any `..`/absolute escape) before writing. */
function safeJoin(root: string, rel: string): string {
  const clean = rel.replace(/^\/+/, "");
  const target = resolve(root, clean);
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + "/") && !target.startsWith(base + "\\")) {
    throw new Error("unsafe path escapes the target dir: " + rel);
  }
  return target;
}

async function fetchToFile(url: string, dest: string, log: Logger): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  const buf = new Uint8Array(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  log("  ✓ " + dest.slice(dest.lastIndexOf("/") + 1) + " (" + buf.length + " bytes)");
  return buf.length;
}

/** Download the transformers.js dist folder (lib + ort wasm) into vendorDir(), flattening /dist/. */
async function downloadVendor(log: Logger): Promise<{ files: number; bytes: number }> {
  const listUrl =
    "https://data.jsdelivr.com/v1/packages/npm/" + VENDOR_PACKAGE + "@" + VENDOR_VERSION + "?structure=flat";
  const res = await fetch(listUrl);
  if (!res.ok) throw new Error("could not list transformers.js files: HTTP " + res.status);
  const listing = (await res.json()) as { files?: Array<{ name?: string }> };
  const distFiles = (listing.files ?? [])
    .map((f) => f.name ?? "")
    .filter((n) => n.startsWith("/dist/") && /\.(js|mjs|wasm|map)$/.test(n));
  if (distFiles.length === 0) throw new Error("no dist files found for " + VENDOR_PACKAGE + "@" + VENDOR_VERSION);

  let files = 0,
    bytes = 0;
  log("vendor: transformers.js@" + VENDOR_VERSION + " (" + distFiles.length + " files)");
  for (const name of distFiles) {
    const rel = name.replace(/^\/dist\//, "");
    const dest = safeJoin(vendorDir(), rel);
    if (existsSync(dest) && statSync(dest).size > 0) continue;
    const url = "https://cdn.jsdelivr.net/npm/" + VENDOR_PACKAGE + "@" + VENDOR_VERSION + name;
    bytes += await fetchToFile(url, dest, log);
    files++;
  }
  return { files, bytes };
}

/** Download an HF model repo (all files, HF layout) into modelsDir()/<id>/. */
async function downloadModel(modelId: string, log: Logger): Promise<{ files: number; bytes: number }> {
  const treeUrl = "https://huggingface.co/api/models/" + modelId + "/tree/main?recursive=1";
  const res = await fetch(treeUrl);
  if (!res.ok) throw new Error("could not list model " + modelId + ": HTTP " + res.status);
  const tree = (await res.json()) as Array<{ type?: string; path?: string }>;
  const paths = tree.filter((e) => e.type === "file" && e.path).map((e) => e.path as string);
  if (paths.length === 0) throw new Error("model " + modelId + " has no files (private or wrong id?)");

  const root = modelsDir() + "/" + modelId;
  let files = 0,
    bytes = 0;
  log("model: " + modelId + " (" + paths.length + " files)");
  for (const p of paths) {
    const dest = safeJoin(root, p);
    if (existsSync(dest) && statSync(dest).size > 0) continue;
    const url = "https://huggingface.co/" + modelId + "/resolve/main/" + p;
    bytes += await fetchToFile(url, dest, log);
    files++;
  }
  return { files, bytes };
}

/**
 * Fetch everything the in-browser Whisper needs for `modelId`, into vendor/ + models/.
 * Idempotent: files already on disk are skipped, so re-running resumes an interrupted download.
 */
export async function downloadWasmAssets(
  modelId: string,
  opts: { onLog?: Logger } = {},
): Promise<DownloadResult> {
  const log = opts.onLog ?? (() => {});
  try {
    const v = await downloadVendor(log);
    const m = await downloadModel(modelId, log);
    return { ok: true, model: modelId, files: v.files + m.files, bytes: v.bytes + m.bytes, error: null };
  } catch (err) {
    return { ok: false, model: modelId, files: 0, bytes: 0, error: (err as Error).message };
  }
}

/** What browser-wasm assets are already on disk for `modelId` (no network). */
export function wasmAssetsStatus(modelId: string): AssetsStatus {
  const libFile = vendorDir() + "/transformers.web.js";
  const libReady = existsSync(libFile) && statSync(libFile).size > 0;

  const root = modelsDir() + "/" + modelId;
  const cfg = existsSync(root + "/config.json");
  // any onnx weight (transformers.js loads from onnx/*.onnx)
  const modelReady = cfg && existsSync(root + "/onnx");

  return {
    libReady,
    modelReady,
    vendorFiles: existsSync(vendorDir()) ? 1 : 0,
    modelFiles: existsSync(root) ? 1 : 0,
  };
}
