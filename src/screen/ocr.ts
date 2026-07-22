// OCR — reads text from a local image file using Windows.Media.Ocr (on-device, no network).
// Runs a temp .ps1 via `-File` (never inline `-Command`). Never throws; returns "" on failure
// or non-Windows platform (that "" is the signal to the caller that Layer 2 can't help).
//
// WinRT from PowerShell needs the canonical AsTask(...) bridge to await IAsyncOperation<T>
// synchronously. The previous version's script was invalid PowerShell (a bad generic param
// type and a comma-assignment) and always parse-errored to "".

import { tmpDir } from "../paths.js";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";

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
  "if (-not $engine) { exit 0 }",  // no OCR pack installed → clean "" (caller escalates)
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

/**
 * OCR a local image file to text using Windows.Media.Ocr.
 * Returns "" if OCR is unavailable (engine/language missing, non-Windows) — never throws.
 */
export function ocrImage(path: string, language?: string | null): string {
  if (process.platform !== "win32") {
    return "";
  }

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
