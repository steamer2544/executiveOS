// Phase 25 — browser-wasm asset fetcher.
// Downloads, ONCE, everything the in-browser Whisper needs so it can then run 100% offline:
//   (a) the transformers.js dist bundle + onnxruntime-web .wasm into .executive/vendor/
//   (b) the HF model repo files into .executive/models/<id>/  (HF directory layout)
// The dashboard serves these from 127.0.0.1 (see server.ts), so the browser never touches the net
// at transcription time — only this one-time download does. Server-side only; not called from the page
// except via the POST /api/transcribe/download endpoint.

import { existsSync, mkdirSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { modelsDir, vendorDir } from "../paths.js";

/** transformers.js package pinned so the served lib + wasm are a matched set. */
const VENDOR_PACKAGE = "@huggingface/transformers";
const VENDOR_VERSION = "3.7.5";

/** transformers.js dtype → HF onnx filename suffix. Whisper repos ship every variant (each 20–200MB);
 *  we fetch ONLY the chosen one so a model is ~80MB, not ~1.6GB. Must match the `dtype` the page passes
 *  to `pipeline(...)`. Default q8 = the "_quantized" files (small + fast on CPU). */
const DTYPE_SUFFIX: Record<string, string> = {
  fp32: "", fp16: "_fp16", q8: "_quantized", int8: "_int8", uint8: "_uint8", q4: "_q4", q4f16: "_q4f16", bnb4: "_bnb4",
};
/** The dtype the dashboard's browser-wasm pipeline uses — keep in sync with page.ts. */
export const WASM_DTYPE = "q8";

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
    // browser build only — the page imports transformers.web.js + the ort wasm. Skip the node/*.cjs builds.
    .filter((n) => n.startsWith("/dist/") && /\.(js|mjs|wasm|map)$/.test(n) && !n.includes(".node."));
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

/**
 * Download the MINIMAL set of an HF Whisper repo into modelsDir()/<id>/: every non-onnx file (the small
 * configs/tokenizers transformers.js always needs) plus ONLY the encoder + merged-decoder for one dtype.
 * A Whisper repo ships ~30 onnx variants (each 20–200MB); grabbing them all is ~1.6GB — grabbing one dtype
 * is ~80MB. Falls back to fp32 for any onnx the chosen dtype doesn't provide.
 */
async function downloadModel(modelId: string, dtype: string, log: Logger): Promise<{ files: number; bytes: number }> {
  const treeUrl = "https://huggingface.co/api/models/" + modelId + "/tree/main?recursive=1";
  const res = await fetch(treeUrl);
  if (!res.ok) throw new Error("could not list model " + modelId + ": HTTP " + res.status);
  const tree = (await res.json()) as Array<{ type?: string; path?: string }>;
  const all = tree.filter((e) => e.type === "file" && e.path).map((e) => e.path as string);
  if (all.length === 0) throw new Error("model " + modelId + " has no files (private or wrong id?)");

  // Which onnx files do we actually want? encoder + decoder_model_merged in the chosen dtype (fp32 fallback).
  const suffix = DTYPE_SUFFIX[dtype] ?? "";
  const onnxSet = new Set(all.filter((p) => p.endsWith(".onnx")));
  const want = (base: string) => {
    const pref = onnxSet.has("onnx/" + base + suffix + ".onnx") ? suffix : "";
    return "onnx/" + base + pref + ".onnx";
  };
  const wantedOnnx = new Set([want("encoder_model"), want("decoder_model_merged")]);
  const paths = all.filter((p) => !p.endsWith(".onnx") || wantedOnnx.has(p));
  log("  (fetching " + dtype + " onnx: " + [...wantedOnnx].map((p) => p.split("/").pop()).join(", ") + ")");

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
  opts: { onLog?: Logger; dtype?: string } = {},
): Promise<DownloadResult> {
  const log = opts.onLog ?? (() => {});
  const dtype = opts.dtype ?? WASM_DTYPE;
  try {
    const v = await downloadVendor(log);
    const m = await downloadModel(modelId, dtype, log);
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
  // Whisper needs BOTH an encoder and a (merged) decoder — a partial download that grabbed only decoders
  // must report not-ready. Check the onnx dir for at least one encoder_* and one decoder_model_merged*.
  let hasEncoder = false, hasDecoder = false;
  try {
    for (const f of readdirSync(root + "/onnx")) {
      if (f.startsWith("encoder_model")) hasEncoder = true;
      if (f.startsWith("decoder_model_merged")) hasDecoder = true;
    }
  } catch {}
  const modelReady = cfg && hasEncoder && hasDecoder;

  return {
    libReady,
    modelReady,
    vendorFiles: existsSync(vendorDir()) ? 1 : 0,
    modelFiles: existsSync(root) ? 1 : 0,
  };
}
