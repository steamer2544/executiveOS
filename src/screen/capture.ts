// Screen capture primitive — reads the active window title + process name on Windows.
// Uses a synchronous PowerShell call (Bun.spawnSync), mirroring the GitWatcher pattern.
// Never captures a screenshot, never reads pixels, never calls OCR or any LLM.

/** Active foreground window: title and process (app) name. */
export interface ForegroundWindow {
  title: string;
  app: string; // process name, e.g. "chrome"
}

/** PowerShell script to query the foreground window.
 *  - `[Console]::OutputEncoding = UTF8` so a Unicode title (Thai/emoji) survives stdout intact.
 *  - `CharSet=CharSet.Unicode` binds GetWindowText**W** (not the ANSI variant, which would
 *    flatten non-ASCII titles to "?" before we ever see them). Both are required — either alone
 *    still mangles Thai window titles like "แชท OPM Dev — LINE". */
const POWERSHELL_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type @"',
  'using System;using System.Text;using System.Runtime.InteropServices;using System.Diagnostics;',
  'public class W {',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);',
  '  public static string Get(){',
  '    IntPtr h=GetForegroundWindow(); var sb=new StringBuilder(1024); GetWindowText(h,sb,1024);',
  '    int pid; GetWindowThreadProcessId(h,out pid);',
  '    string p=""; try{ p=Process.GetProcessById(pid).ProcessName; }catch{}',
  '    return sb.ToString()+"\\t"+p;',
  '  }',
  '}',
  '"@',
  '[W]::Get()',
].join("\n");

let warned = false;

/**
 * Return the current foreground window's title + process name, or null if unavailable
 * (non-Windows, no focused window, or the query failed). Never throws. Synchronous.
 */
export function foregroundWindow(): ForegroundWindow | null {
  // Fast path: skip spawnSync on non-Windows entirely.
  if (process.platform !== "win32") {
    if (!warned) {
      process.stderr.write("ScreenWatcher: not running on Windows — foreground window unavailable\n");
      warned = true;
    }
    return null;
  }

  try {
    const result = Bun.spawnSync(["powershell", "-NoProfile", "-Command", POWERSHELL_SCRIPT], {
      stdout: "pipe",
      stderr: "pipe",
    });

    if (result.exitCode !== 0) {
      if (!warned) {
        const err = new TextDecoder().decode(result.stderr).trim();
        process.stderr.write("ScreenWatcher: capture failed (exit " + result.exitCode + "): " + err + "\n");
        warned = true;
      }
      return null;
    }

    const output = new TextDecoder().decode(result.stdout).trim();
    if (!output) {
      return null;
    }

    // Parse "title<TAB>app" line.
    const tabIdx = output.indexOf("\t");
    if (tabIdx < 0) {
      return null;
    }

    const title = output.slice(0, tabIdx);
    const app = output.slice(tabIdx + 1);

    // Empty title → null.
    if (!title || title.trim() === "") {
      return null;
    }

    return { title, app };
  } catch {
    // spawnSync threw (e.g. no PowerShell) — warn once.
    if (!warned) {
      process.stderr.write("ScreenWatcher: capture command unavailable — will keep polling\n");
      warned = true;
    }
    return null;
  }
}
