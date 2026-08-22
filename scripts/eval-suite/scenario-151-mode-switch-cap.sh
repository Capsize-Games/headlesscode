#!/usr/bin/env bash
set -uo pipefail

# Live eval for issue #151 (self-improvement pipeline): spawns a REAL
# session against the code-daemon (qwen3-14b) and verifies switch_mode's
# hard cap (DEFAULT_MAX_MODE_SWITCHES, loop.ts:4656 — unit-tested directly
# in loop.test.ts as of db86c70/7cbd208) fires for real against a live
# model, not just a scripted FakeLlmClient. --max-mode-switches 2
# overrides the real default (5) down to 2 so the eval only needs 3
# switch_mode calls to trip it — same code path, fewer live turns to stay
# reliable, matching this session's own observed ceiling for tasks a
# local model can follow without drifting (short, explicit, mechanical
# instruction sequences).
#
# PASS condition: the log shows the exact "max mode switches reached (2
# >= max 2)" tool-error text AND the session still reaches a real
# attempt_completion afterward (the cap is a recoverable tool error, not
# a fatal one — this is the behavior the unit test enforces; this script
# confirms a live model actually recovers from it instead of spinning).
#
# Usage: scripts/eval-suite/scenario-151-mode-switch-cap.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
WS="$(mktemp -d "${TMPDIR:-/tmp}/headlesscode-eval-151-XXXXXX")"
LOG="$REPO_ROOT/.headlesscode/scratch/eval-suite/151-mode-switch-$STAMP.log"
mkdir -p "$REPO_ROOT/.headlesscode/scratch/eval-suite"

cd "$WS"
git init -q
git config user.email "eval@local"
git config user.name "eval"
echo "hello" > a.txt
git add -A && git commit -q -m "initial fixture"

TASK_FILE="${TMPDIR:-/tmp}/headlesscode-eval-151-task-$STAMP.md"
cat > "$TASK_FILE" <<'EOF'
## Rules
- Unattended: never use ask_followup_question.
- CRITICAL: call exactly ONE tool per response, and nothing else in that
  same response — no other tool calls, not even attempt_completion,
  may appear alongside it. switch_mode in particular is REJECTED
  outright if it shares a response with any other tool call. Send the
  tool call, then STOP and wait for its result before your next
  response.

## Task

Do these four steps, each as the SOLE tool call in its own separate
response — never combine two of them in the same response:

1. Call switch_mode with mode_slug "architect" and any short reason.
2. Call switch_mode with mode_slug "code" and any short reason.
3. Call switch_mode with mode_slug "architect" and any short reason
   again. This third call may be refused — if it is, that is the
   expected, correct result. Do not retry it, just move to step 4.
4. Call attempt_completion with result "done", by itself.
EOF

echo "Workspace: $WS"
echo "Log file:  $LOG"
echo "--- spawning a real session against the code-daemon (qwen3-14b), --max-mode-switches 2 ---"

cd "$REPO_ROOT"
HEADLESSCODE_CODE_MODE_BACKEND=ollama \
HEADLESSCODE_LOCAL_BACKEND_MODES=code \
HEADLESSCODE_OLLAMA_URL=http://localhost:11435 \
HEADLESSCODE_CODE_MODE_MODEL=qwen3-14b:latest \
npx tsx src/cli.ts \
	--mode code \
	--task-file "$TASK_FILE" \
	--workspace "$WS" \
	--max-iterations 15 \
	--max-mode-switches 2 \
	--auto-approve-mode-switch \
	--log-file "$LOG" \
	> "$LOG.stdout" 2>&1
DISPATCH_EXIT=$?

echo ""
echo "--- dispatch exit: $DISPATCH_EXIT ---"

# The plain --log-file stream only records isError + a tool-call counter,
# never the actual tool-result CONTENT (confirmed live 2026-08-21: an
# earlier version of this script grepped $LOG for the cap message and
# always failed even when the cap fired correctly). The events JSONL
# (.headlesscode/events/<sessionId>.jsonl) is the artifact that carries
# full tool_result content — that's what must be checked here.
EVENTS_FILE="$(find "$WS/.headlesscode/events" -type f -name '*.jsonl' 2>/dev/null | head -1)"

echo "--- relevant events ---"
if [ -n "$EVENTS_FILE" ]; then
	grep -E "mode_switched|switch_mode" "$EVENTS_FILE" 2>/dev/null
fi

RESULT=0

if [ -n "$EVENTS_FILE" ] && grep -q "max mode switches reached (2 >= max 2)" "$EVENTS_FILE" 2>/dev/null; then
	echo ""
	echo "PASS (cap fired): live session hit the real cap with the exact expected message."
else
	echo ""
	echo "FAIL: the cap message never appeared in the events log — guardrail did not fire as expected."
	RESULT=1
fi

if [ -n "$EVENTS_FILE" ] && grep -q '"type":"attempt_completion"' "$EVENTS_FILE" 2>/dev/null; then
	echo "PASS (recovered): the session reached a real attempt_completion after the refusal, not a stall."
else
	echo "FAIL: the session never reached attempt_completion — did not recover from the refusal."
	RESULT=1
fi

rm -rf "$WS" "$TASK_FILE"
exit $RESULT
