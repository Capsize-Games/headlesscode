#!/usr/bin/env bash
set -uo pipefail

# Live eval for issue #151: spawns a REAL session against the code-daemon
# (qwen3-14b) and verifies new_task's recursion-depth cap
# (DEFAULT_MAX_RECURSION_DEPTH, loop.ts:4471 — unit-tested directly in
# loop.test.ts as of 7cbd208) fires against real live model output, not
# just a scripted FakeLlmClient. --max-recursion-depth 0 is rejected by
# the CLI's own arg validation (requires a positive integer), so this
# uses --max-recursion-depth 1: the root's new_task call is ALLOWED
# (depth 0 -> 1), and the real child session it spawns is given the same
# "attempt new_task, expect refusal" instructions — its own new_task
# call is refused (depth 1 >= max 1), the actual live trigger. This
# means the guardrail is exercised inside a REAL nested child session,
# not just the root.
#
# PASS condition: the events JSONL shows the exact "max recursion depth
# reached (depth 1 >= max 1)" tool-error text AND the root session
# still reaches a real attempt_completion afterward (recoverable, not
# fatal, even though its child hit an internal refusal).
#
# NOTE on verification artifact: --log-file's plain log stream only ever
# records isError + a call counter, never the actual tool-result content
# (discovered live 2026-08-21 building the mode-switch-cap eval) — this
# script checks .headlesscode/events/<sessionId>.jsonl instead, which
# carries the real message text.
#
# Usage: scripts/eval-suite/scenario-151-recursion-depth-cap.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
WS="$(mktemp -d "${TMPDIR:-/tmp}/headlesscode-eval-151rd-XXXXXX")"
LOG="$REPO_ROOT/.headlesscode/scratch/eval-suite/151-recursion-depth-$STAMP.log"
mkdir -p "$REPO_ROOT/.headlesscode/scratch/eval-suite"

cd "$WS"
git init -q
git config user.email "eval@local"
git config user.name "eval"
echo "hello" > a.txt
git add -A && git commit -q -m "initial fixture"

TASK_FILE="${TMPDIR:-/tmp}/headlesscode-eval-151rd-task-$STAMP.md"
cat > "$TASK_FILE" <<'EOF'
## Rules
- Unattended: never use ask_followup_question.
- CRITICAL: call exactly ONE tool per response, and nothing else in that
  same response. Send the tool call, then STOP and wait for its next
  result before your next response.
- CRITICAL: call new_task AT MOST ONCE, ever, in this entire session,
  no matter what result it returns. Do not call it a second time even
  if the first result seems unexpected or incomplete.

## Task

Do these three steps, each as the SOLE tool call in its own separate
response:

1. Call write_to_file with path "note.txt" and content "delegated a
   subtask".
2. Call new_task with mode "code" and this EXACT message (copy it
   verbatim): "Do these two steps, each as the SOLE tool call in its
   own separate response: 1. Call new_task with mode code and message
   'report success' by itself. This call will be refused - that is
   the expected, correct result, do not retry it. 2. Call
   attempt_completion with result done, by itself." Whatever result
   this returns, do NOT call new_task again — proceed straight to
   step 3.
3. Call attempt_completion with result "done", by itself.
EOF

echo "Workspace: $WS"
echo "Log file:  $LOG"
echo "--- spawning a real session against the code-daemon (qwen3-14b), --max-recursion-depth 1 ---"

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
	--max-recursion-depth 1 \
	--log-file "$LOG" \
	> "$LOG.stdout" 2>&1
DISPATCH_EXIT=$?

echo ""
echo "--- dispatch exit: $DISPATCH_EXIT ---"

# A --max-recursion-depth 1 run spawns TWO sessions (root + child), each
# writing its OWN sessionId-named events file — the cap message actually
# lives in the CHILD's file, not the root's. An earlier version of this
# script used `find ... | head -1` (only the first file found, often the
# root's) and reported a false FAIL despite the log clearly showing the
# cap fired correctly. Search ALL events files under this workspace.
EVENTS_FILES=("$WS"/.headlesscode/events/*.jsonl)

echo "--- relevant events (all sessions) ---"
if [ -e "${EVENTS_FILES[0]}" ]; then
	grep -h -E "new_task|max recursion" "${EVENTS_FILES[@]}" 2>/dev/null
fi

RESULT=0

if [ -e "${EVENTS_FILES[0]}" ] && grep -l -q "max recursion depth reached (depth 1 >= max 1)" "${EVENTS_FILES[@]}" 2>/dev/null; then
	echo ""
	echo "PASS (cap fired): live session hit the real cap with the exact expected message."
else
	echo ""
	echo "FAIL: the cap message never appeared in any events log — guardrail did not fire as expected."
	RESULT=1
fi

# cli.ts returns exit 0 only when the ROOT session's own result.status is
# "success" (see the end of main() in src/cli.ts) — a more direct signal
# than re-deriving root-vs-child success from the events files.
if [ "$DISPATCH_EXIT" -eq 0 ]; then
	echo "PASS (recovered): the root session reached a real attempt_completion after the refusal, not a stall."
else
	echo "FAIL: the root session did not finish successfully (exit $DISPATCH_EXIT) — did not recover from the refusal."
	RESULT=1
fi

rm -rf "$WS" "$TASK_FILE"
exit $RESULT
