// OCR — reads text from a local image file using Windows.Media.Ocr (on-device, no network)
// or Tesseract-OCR. Never throws; returns "" on failure or non-Windows platform (that "" is the
// signal to the caller that Layer 2 can't help).
//
// WinRT from PowerShell needs the canonical AsTask(...) bridge to await IAsyncOperation<T>
// synchronously. The previous version's script was invalid PowerShell (a bad generic param
// type and a comma-assignment) and always parse-errored to "".

import { tmpDir } from "../paths.js";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { normalize, join } from "node:path";

// Static script body (AMSI-safe as a -File). $args[0] = image path, $args[1] = optional BCP-47 language.
const OCR_PS1 = [
  "$ErrorActionPreference = 'Stop'",
  "$path = $args[0]",
  "$lang = $args[1]",
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  // Load the WinRT projections we need.
  "[void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]",
  "[void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]",
  "[void][Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime]",
  // Bridge to synchronously await an IAsyncOperation<T>.
  "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  "function Await($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }",
  // Create the OCR engine (specific language if given, else the user's profile languages).
  "$engine = $null",
  "if ($lang) { try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($lang))) } catch { } }",
  "if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }",
  "if (-not $engine) { exit 0 }",  // no OCR pack installed -> clean "" (caller escalates)
  // Decode the image and recognize.
  "$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])",
  "$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])",
  "$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])",
  "$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])",
  "$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])",
  "$lines = @(); foreach ($l in $result.Lines) { $lines += $l.Text }",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "[Console]::Out.Write(($lines -join \"`n\"))",
].join("\n");

/** Options for selecting the OCR engine. */
export interface OcrOptions {
  engine?: "winrt" | "tesseract";
  languages?: string;       // tesseract, e.g. "tha+eng"; "auto" → guess (see resolveOcrLanguages)
  tesseractPath?: string | null;
}

/** Thai block, U+0E00–U+0E7F. */
const THAI_RE = /[\u0E00-\u0E7F]/;

/** True when the string contains at least one Thai character. */
export function hasThai(s: string | null | undefined): boolean {
  return typeof s === "string" && THAI_RE.test(s);
}

/** The configured value that means "decide for me" (also: empty/absent). */
const AUTO = "auto";

/**
 * Resolve the Tesseract `-l` language list for one screenshot.
 *
 * WHY this exists: passing `tha+eng` at all times makes Tesseract HALLUCINATE Thai on an
 * all-English screen. Measured on one real screenshot: `-l eng` → 0 Thai chars / 8 English
 * words; `-l tha+eng` → 59 garbage Thai chars / 7 English words — so the wrong list both adds
 * noise AND costs English accuracy. It is not a resolution artifact (native 1536×960 is the
 * same). See GOTCHA.md §2.
 *
 * The signal used to decide is the Layer 1 foreground window TITLE, which is trustworthy
 * precisely because it does not come from OCR: `capture.ts` reads it via `GetWindowTextW`, so
 * Thai arrives intact. `getTitle` is a thunk so the caller pays for the (spawnSync) lookup only
 * when the answer can change the outcome — a manual setting never reads the window at all.
 *
 * @param configured — `config.screen.ocr.languages`. Anything non-empty other than "auto" is a
 *                     MANUAL OVERRIDE and always wins.
 * @param getTitle   — returns the active window title, or null when unknown.
 */
export function resolveOcrLanguages(
  configured: string | null | undefined,
  getTitle: () => string | null,
): string {
  const manual = typeof configured === "string" ? configured.trim() : "";
  if (manual.length > 0 && manual.toLowerCase() !== AUTO) {
    return manual;
  }

  const title = getTitle();
  // Unknown title → keep the old behaviour. Guessing "eng" would DROP Thai outright, whereas
  // "tha+eng" only adds noise the reader can survive: uncertain → do not throw information away.
  if (title === null || title.trim().length === 0) {
    return "tha+eng";
  }
  return hasThai(title) ? "tha+eng" : "eng";
}

/**
 * Resolve the Tesseract-OCR executable path.
 *
 * Checks configured path (if non-empty and exists), then well-known install locations,
 * then falls back to bare "tesseract" for PATH resolution. Never throws.
 */
export function resolveTesseractPath(configured?: string | null): string | null {
  // 1. configured (only if non-empty AND exists on disk)
  if (configured && configured.trim().length > 0) {
    if (existsSync(configured)) return configured;
    // Falling back is friendlier than failing, but a typo'd path must not be invisible —
    // otherwise the owner thinks they are running the binary they named.
    process.stderr.write(
      "ocr: configured tesseractPath does not exist, falling back to auto-detect: " + configured + "\n",
    );
  }

  // 2. Program Files (64-bit)
  const pf64 = "C:\\Program Files\\Tesseract-OCR\\tesseract.exe";
  if (existsSync(pf64)) return pf64;

  // 3. Program Files (x86)
  const pf32 = "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe";
  if (existsSync(pf32)) return pf32;

  // 4. LOCALAPPDATA\\Programs
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const localPath = join(localAppData, "Programs", "Tesseract-OCR", "tesseract.exe");
    if (existsSync(localPath)) return localPath;
  }

  // 5. bare "tesseract" — let PATH resolve it
  return "tesseract";
}

/**
 * Normalize Tesseract's Thai OCR output.
 *
 * Tesseract emits sara-am in decomposed form: ก + U+0E4D (nikhahit) + U+0E32 (sara aa).
 * NFC normalization alone does NOT recompose U+0E4D U+0E32 -> U+0E33, so we replace the
 * two-codepoint sequence with the single character explicitly first.
 */
export function normalizeThaiOcr(text: string): string {
  if (text.length === 0) return text;
  // Replace EVERY nikhahit (U+0E4D) + sara-aa (U+0E32) pair with composed sara-am (U+0E33).
  // The regex must be global: a string first argument replaces only the first occurrence, which
  // leaves every sara-am word after the first one decomposed.
  return text.replace(/ํา/g, "ำ").normalize("NFC");
}

/**
 * OCR a local image file to text.
 *
 * @param path — path to the image file
 * @param language — optional BCP-47 language for WinRT (e.g. "th-TH")
 * @param opts — optional engine selection and Tesseract config
 * Returns "" if OCR is unavailable (engine/language missing, non-Windows) — never throws.
 */
export function ocrImage(
  path: string,
  language?: string | null,
  opts?: OcrOptions,
): string {
  if (process.platform !== "win32") {
    return "";
  }

  const engine = opts?.engine === "tesseract" ? "tesseract" : "winrt";

  if (engine === "tesseract") {
    return runTesseract(path, opts);
  }

  return runWinRtOcr(path, language);
}

// --- WinRT path (unchanged from original) ---

function runWinRtOcr(path: string, language?: string | null): string {
  // WinRT StorageFile.GetFileFromPathAsync requires an OS-native absolute path; a mixed/forward-
  // slash path faults with an AggregateException. Normalize defensively regardless of caller.
  path = normalize(path);

  const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const scriptPath = tmpDir() + "/ocr-" + stamp + ".ps1";

  try {
    mkdirSync(tmpDir(), { recursive: true });
    writeFileSync(scriptPath, OCR_PS1);

    // -Sta is REQUIRED: WinRT StorageFile/OCR async ops fault in an MTA apartment (which is
    // what a bare spawned powershell uses); STA makes GetFileFromPathAsync/RecognizeAsync work.
    const args = ["powershell", "-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-File", scriptPath, path];
    if (language) args.push(language);

    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });

    if (result.exitCode !== 0) {
      const err = new TextDecoder().decode(result.stderr).trim();
      process.stderr.write("ocr: recognition failed (exit " + result.exitCode + "): " + err + "\n");
      return "";
    }

    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    process.stderr.write("ocr: recognition command unavailable\n");
    return "";
  } finally {
    try {
      unlinkSync(scriptPath);
    } catch {
      // best-effort
    }
  }
}

// --- Tesseract path ---

function runTesseract(path: string, opts?: OcrOptions): string {
  const exe = resolveTesseractPath(opts?.tesseractPath);
  if (!exe) {
    process.stderr.write("ocr: tesseract not found\n");
    return "";
  }

  // Normalize the image path — both WinRT and Tesseract dislike mixed separators.
  const imagePath = normalize(path);
  // Defensive: a caller that passes "auto" (or nothing) straight through must never reach
  // tesseract as `-l auto`. Resolving with a null title yields the old "tha+eng" default; the
  // window-title guess is made by the caller, which is the layer that knows the title.
  const languages = resolveOcrLanguages(opts?.languages, () => null);

  try {
    const result = Bun.spawnSync(
      [exe, imagePath, "stdout", "-l", languages],
      { stdout: "pipe", stderr: "pipe" },
    );

    if (result.exitCode !== 0) {
      const err = new TextDecoder().decode(result.stderr).trim();
      process.stderr.write("ocr: tesseract failed (exit " + result.exitCode + "): " + err + "\n");
      return "";
    }

    const text = new TextDecoder().decode(result.stdout);
    return normalizeThaiOcr(text).trim();
  } catch {
    // Spawn itself threw (missing exe, etc.)
    process.stderr.write("ocr: tesseract command unavailable\n");
    return "";
  }
}
