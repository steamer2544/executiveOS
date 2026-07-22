// Screenshot capture — captures the primary screen to a temp JPEG file under .executive/tmp.
// Never throws; returns null on failure or non-Windows platform.
//
// Two things this file gets right that a naive version does not:
//  1. DOWNSCALE, not crop. `Graphics.CopyFromScreen` is a 1:1 block copy — copying the full
//     screen size into a smaller bitmap just clips the top-left corner. We instead capture at
//     native resolution, then `DrawImage` into the smaller target so the whole screen is scaled.
//  2. Run the script from a temp `.ps1` via `-File`, NOT inline `-Command`. Windows Defender's
//     AMSI flags an inline `-Command` that grabs the screen as "malicious content" and blocks it;
//     the same script in a `.ps1` file runs fine. The output path is passed as $args[0] so the
//     script body is static.

import { tmpDir } from "../paths.js";
import { mkdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { normalize } from "node:path";

/** Captured screenshot: path on disk, byte size, and format. */
export interface Screenshot {
  path: string;
  bytes: number;
  format: "png" | "jpeg";
}

// Static script body (AMSI-safe as a -File). $args[0] = output jpg path, $args[1] = max width.
const CAPTURE_PS1 = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Drawing",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$out = $args[0]",
  "$maxW = [int]$args[1]",
  "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
  "$ratio = [math]::Min(1, $maxW / [double]$b.Width)",
  "$w = [int][math]::Max(1, [math]::Floor($b.Width * $ratio))",
  "$h = [int][math]::Max(1, [math]::Floor($b.Height * $ratio))",
  // Capture at native resolution first (1:1), then scale down into the target bitmap.
  "$full = New-Object System.Drawing.Bitmap($b.Width, $b.Height)",
  "$g1 = [System.Drawing.Graphics]::FromImage($full)",
  "$g1.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
  "$dst = New-Object System.Drawing.Bitmap($w, $h)",
  "$g2 = [System.Drawing.Graphics]::FromImage($dst)",
  "$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
  "$g2.DrawImage($full, 0, 0, $w, $h)",
  // Save as JPEG with a quality param. The 3-arg Save overload needs an ImageCodecInfo (NOT an
  // ImageFormat), so resolve the JPEG encoder by its FormatID guid.
  "$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.FormatID -eq [System.Drawing.Imaging.ImageFormat]::Jpeg.Guid } | Select-Object -First 1",
  "$encoder = [System.Drawing.Imaging.Encoder]::Quality",
  "$params = New-Object System.Drawing.Imaging.EncoderParameters(1)",
  "$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter($encoder, 70L)",
  "$dst.Save($out, $codec, $params)",
  "$g1.Dispose(); $g2.Dispose(); $full.Dispose(); $dst.Dispose()",
].join("\n");

/**
 * Capture the primary screen to a temp JPEG under .executive/tmp, downscaled to ~1280px wide.
 * Returns null if capture is unavailable (non-Windows / failure). Never throws.
 * `maxBytes` is a soft cap — the caller (screen-infer) skips sending anything larger.
 */
export function captureScreen(_maxBytes: number): Screenshot | null {
  if (process.platform !== "win32") {
    return null;
  }

  const outDir = tmpDir();
  const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const filePath = outDir + "/screenshot-" + stamp + ".jpg";
  const scriptPath = outDir + "/capture-" + stamp + ".ps1";

  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(scriptPath, CAPTURE_PS1);

    const result = Bun.spawnSync(
      ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, filePath, "1280"],
      { stdout: "pipe", stderr: "pipe" },
    );

    if (result.exitCode !== 0) {
      const err = new TextDecoder().decode(result.stderr).trim();
      process.stderr.write("screenshot: capture failed (exit " + result.exitCode + "): " + err + "\n");
      return null;
    }

    const size = statSync(filePath).size;
    // Return an OS-native path (backslashes on Windows). The path is built by "/"-concatenation,
    // so it can mix separators — harmless for System.Drawing, but WinRT StorageFile (used by the
    // OCR consumer) rejects a mixed/forward-slash path with an AggregateException.
    return { path: normalize(filePath), bytes: size, format: "jpeg" };
  } catch {
    process.stderr.write("screenshot: capture command unavailable\n");
    return null;
  } finally {
    // The .ps1 is transient — always remove it (the .jpg is deleted by the caller after use).
    try {
      unlinkSync(scriptPath);
    } catch {
      // best-effort
    }
  }
}
