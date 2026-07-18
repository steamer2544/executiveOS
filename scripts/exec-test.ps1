# exec-test.ps1 — run a test command, then emit its pass/fail to ExecutiveOS.
#
# Usage (from your project dir, with EXECUTIVE pointing at the runtime):
#   pwsh <path>/executive/scripts/exec-test.ps1 "bun test"
#   pwsh <path>/executive/scripts/exec-test.ps1 "npm test"
#
# It runs the command, forwards its output, and emits:
#   system.test_result {"status":"passing"|"failing"}
# so `report` / the watch daemon see your real test state without manual emits.
#
# EXECUTIVE_HOME (optional) controls which .executive/ dir the event goes to.

param(
  [Parameter(Mandatory = $true)]
  [string]$TestCommand
)

# Resolve the runtime entrypoint relative to this script (scripts/ -> src/index.ts).
$indexPath = Join-Path $PSScriptRoot "..\src\index.ts"

Write-Host "› running: $TestCommand"
Invoke-Expression $TestCommand
$code = $LASTEXITCODE

if ($code -eq 0) {
  $status = "passing"
} else {
  $status = "failing"
}

Write-Host "› emitting system.test_result: $status (exit $code)"
& bun run $indexPath emit system system.test_result "{`"status`":`"$status`"}" | Out-Null

exit $code
