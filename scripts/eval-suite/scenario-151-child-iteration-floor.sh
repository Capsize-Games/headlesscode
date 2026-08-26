#!/usr/bin/env bash
set -uo pipefail

# Live eval for issue #151: spawns a REAL session against the code-daemon
# (qwen3-14b) and verifies new_task's child-iteration floor
# (DEFAULT_MIN_CHILD_ITERATIONS, loop.ts's handleNewTask — unit-tested
# directly in loop.test.ts as of 9e01cd3) against real live model
# output. --child-iteration-fraction 0.01 forces floor(remaining*0.01)
# to round to 0 for any reasonable remaining value, so
# max(minChildIterations, 0) always resolves to exactly
# DEFAULT_MIN_CHILD_ITERATIONS (3) regardless of the parent's exact
# maxIterations — the floor always wins, deterministically.
#
# The child is given an intentionally unsolvable task (count to a number
# far beyond what 3 iterations of read-only exploration could ever
# finish), so it reliably burns its whole 3-iteration budget and hits
# its own bounded max-iterations failure — the live trigger for the
# floor's real value being applied.
#
# PASS condition: the events JSONL shows the child's real "made N tool
# call(s) over 3 iteration(s)" text (the exact real message new_task
# returns to the parent on child failure) AND the root session still
# reaches a real attempt_completion afterward.
#
# Usage: scripts/eval-suite/scenario-151-child-iteration-floor.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
WS="$(mktemp -d "${TMPDIR:-/tmp}/headlesscode-eval-151cf-XXXXXX")"
LOG="$REPO_ROOT/.headlesscode/scratch/eval-suite/151-child-floor-$STAMP.log"
mkdir -p "$REPO_ROOT/.headlesscode/scratch/eval-suite"

cd "$WS"
git init -q
git config user.email "eval@local"
git config user.name "eval"
echo "hello" > a.txt
git add -A && git commit -q -m "initial fixture"

TASK_FILE="${TMPDIR:-/tmp}/headlesscode-eval-151cf-task-$STAMP.md"
cat > "$TASK_FILE" <<'EOF'
## Rules
- Unattended: never use ask_followup_question.
- CRITICAL: call exactly ONE tool per response, and nothing else in that
  same response. Send the tool call, then STOP and wait for its result
  before your next response.
- CRITICAL: call new_task AT MOST ONCE, ever, in this entire session,
  no matter what result it returns. Do not call it a second time even
  if the first result seems unexpected, incomplete, or like a failure.

## Task

Do these three steps, each as the SOLE tool call in its own separate
response:

1. Call write_to_file with path "note.txt" and content "delegated a
   subtask".
2. Call new_task with mode "code" and message "List the files in this
   directory, then read each one, then compute the SHA-256 hash of
   every possible 500-character substring of the combined contents and
   report the lexicographically smallest one. This is intentionally
   very long-running." It is expected and fine if this child runs out
   of its iteration budget and returns a failure — that is the
   expected, correct result. Do NOT call new_task again — proceed
   straight to step 3 regardless of what result you get.
3. Call attempt_completion with result "done", by itself.
EOF

echo "Workspace: $WS"
echo "Log file:  $LOG"
echo "--- spawning a real session against the code-daemon (qwen3-14b), --child-iteration-fraction 0.01 ---"

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
	--child-iteration-fraction 0.01 \
	--log-file "$LOG" \
	> "$LOG.stdout" 2>&1
DISPATCH_EXIT=$?

echo ""
echo "--- dispatch exit: $DISPATCH_EXIT ---"

# Same multi-session events-file lesson as scenario-151-recursion-depth-cap.sh:
# search ALL sessionId-named events files under this workspace, not just
# the first one `find` happens to return.
EVENTS_FILES=("$WS"/.headlesscode/events/*.jsonl)

echo "--- relevant events (all sessions) ---"
if [ -e "${EVENTS_FILES[0]}" ]; then
	grep -h -E "new_task|iteration\(s\)" "${EVENTS_FILES[@]}" 2>/dev/null
fi

RESULT=0

if [ -e "${EVENTS_FILES[0]}" ] && grep -l -q "over 3 iteration(s)" "${EVENTS_FILES[@]}" 2>/dev/null; then
	echo ""
	echo "PASS (floor applied): the child was capped at exactly DEFAULT_MIN_CHILD_ITERATIONS (3), not a smaller fraction-derived value."
else
	echo ""
	echo "FAIL: no evidence the child was capped at exactly 3 iterations — guardrail did not fire as expected."
	RESULT=1
fi

# cli.ts returns exit 0 only when the ROOT session's own result.status is
# "success" — a more direct signal than re-deriving success from events.
if [ "$DISPATCH_EXIT" -eq 0 ]; then
	echo "PASS (recovered): the root session reached a real attempt_completion after the child's failure, not a stall."
else
	echo "FAIL: the root session did not finish successfully (exit $DISPATCH_EXIT) — did not recover from the child's failure."
	RESULT=1
fi

rm -rf "$WS" "$TASK_FILE"
exit $RESULT
