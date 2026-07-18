#!/usr/bin/env bash
# exec-test.sh — run a test command, then emit its pass/fail to ExecutiveOS.
#
# Usage (from your project dir):
#   <path>/executive/scripts/exec-test.sh "bun test"
#   <path>/executive/scripts/exec-test.sh "npm test"
#
# It runs the command, forwards its output, and emits:
#   system.test_result {"status":"passing"|"failing"}
# so `report` / the watch daemon see your real test state without manual emits.
#
# EXECUTIVE_HOME (optional) controls which .executive/ dir the event goes to.

set -o pipefail
CMD="$1"
if [ -z "$CMD" ]; then
  echo "usage: exec-test.sh \"<test command>\"" >&2
  exit 2
fi

# Resolve the runtime entrypoint relative to this script (scripts/ -> src/index.ts).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INDEX="$DIR/../src/index.ts"

echo "› running: $CMD"
eval "$CMD"
code=$?

if [ "$code" -eq 0 ]; then status="passing"; else status="failing"; fi

echo "› emitting system.test_result: $status (exit $code)"
bun run "$INDEX" emit system system.test_result "{\"status\":\"$status\"}" >/dev/null

exit "$code"
