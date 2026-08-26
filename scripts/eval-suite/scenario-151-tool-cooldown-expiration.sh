#!/usr/bin/env bash
set -uo pipefail

# Live eval for issue #151: spawns a REAL session against the code-daemon
# (qwen3-14b) and verifies the identical-call tool-exclusion cooldown's
# exact expiration (DEFAULT_IDENTICAL_CALL_TOOL_COOLDOWN_TURNS = 4,
# loop.ts's runIterations decay loop — unit-tested directly in
# loop.test.ts as of c879fc0) against real live model output. Uses the
# REAL defaults throughout (no CLI override exists or is needed for
# this constant) — the longest/most turn-heavy of the #151 live evals,
# so it carries the highest live-drift risk of the four.
#
# Sequence: 2 identical list_files calls trip the identical-call guard
# (DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD = 2), which excludes list_files
# for the next DEFAULT_IDENTICAL_CALL_TOOL_COOLDOWN_TURNS (4) requests.
# 4 turns of distinct read_file calls (which can't retrigger the guard,
# unlike a repeated list_files would) let the cooldown decay naturally
# instead of refreshing. list_files should then be usable again.
#
# PASS condition: the events JSONL shows list_files actually running
# successfully a SECOND time (not just being present in a later
# request's offered tools — this checks the real executed result) AND
# the session reaches a real attempt_completion.
#
# Usage: scripts/eval-suite/scenario-151-tool-cooldown-expiration.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
WS="$(mktemp -d "${TMPDIR:-/tmp}/headlesscode-eval-151tc-XXXXXX")"
LOG="$REPO_ROOT/.headlesscode/scratch/eval-suite/151-tool-cooldown-$STAMP.log"
mkdir -p "$REPO_ROOT/.headlesscode/scratch/eval-suite"

cd "$WS"
git init -q
git config user.email "eval@local"
git config user.name "eval"
for i in 1 2 3 4; do
	echo "content $i" > "f$i.txt"
done
git add -A && git commit -q -m "initial fixture"

TASK_FILE="${TMPDIR:-/tmp}/headlesscode-eval-151tc-task-$STAMP.md"
cat > "$TASK_FILE" <<'EOF'
## Rules
- Unattended: never use ask_followup_question.
- CRITICAL: call exactly ONE tool per response, and nothing else in that
  same response. Send the tool call, then STOP and wait for its result
  before your next response.

## Task

Do these exact steps, in order, each as the SOLE tool call in its own
separate response:

1. Call write_to_file with path "note.txt" and content "exploring".
2. Call list_files with path ".".
3. Call list_files with path "." again (the identical call, on
   purpose).
4. Call read_file on "f1.txt".
5. Call read_file on "f2.txt".
6. Call read_file on "f3.txt".
7. Call read_file on "f4.txt".
8. Call list_files with path "." one more time. If it is unavailable
   or refused, that is unexpected but not an error on your part — just
   proceed to step 9 regardless of what happens in step 8.
9. Call attempt_completion with result "done", by itself.
EOF

echo "Workspace: $WS"
echo "Log file:  $LOG"
echo "--- spawning a real session against the code-daemon (qwen3-14b), real defaults ---"

cd "$REPO_ROOT"
HEADLESSCODE_CODE_MODE_BACKEND=ollama \
HEADLESSCODE_LOCAL_BACKEND_MODES=code \
HEADLESSCODE_OLLAMA_URL=http://localhost:11435 \
HEADLESSCODE_CODE_MODE_MODEL=qwen3-14b:latest \
npx tsx src/cli.ts \
	--mode code \
	--task-file "$TASK_FILE" \
	--workspace "$WS" \
	--max-iterations 20 \
	--log-file "$LOG" \
	> "$LOG.stdout" 2>&1
DISPATCH_EXIT=$?

echo ""
echo "--- dispatch exit: $DISPATCH_EXIT ---"

EVENTS_FILE="$(find "$WS/.headlesscode/events" -type f -name '*.jsonl' 2>/dev/null | head -1)"

echo "--- relevant events ---"
if [ -n "$EVENTS_FILE" ]; then
	grep -E "list_files" "$EVENTS_FILE" 2>/dev/null
fi

RESULT=0

# Two SUCCESSFUL list_files tool_result events expected: the first pair
# (steps 1-2, both real — exclusion only affects what's OFFERED on
# later requests, not these) and a later one from step 7 once the
# cooldown has expired.
LIST_FILES_SUCCESS_COUNT="$(grep -c '"type":"tool_result","iteration":[0-9]*,"tool":"list_files","isError":false' "$EVENTS_FILE" 2>/dev/null || echo 0)"

if [ "$LIST_FILES_SUCCESS_COUNT" -ge 3 ]; then
	echo ""
	echo "PASS (cooldown expired): list_files ran successfully at least 3 times (2 before exclusion + 1 after the cooldown decayed)."
else
	echo ""
	echo "FAIL: list_files only succeeded $LIST_FILES_SUCCESS_COUNT time(s) — expected >= 3 (2 before exclusion, 1+ after expiration)."
	RESULT=1
fi

if [ -n "$EVENTS_FILE" ] && grep -q '"type":"attempt_completion"' "$EVENTS_FILE" 2>/dev/null; then
	echo "PASS (completed): the session reached a real attempt_completion."
else
	echo "FAIL: the session never reached attempt_completion."
	RESULT=1
fi

rm -rf "$WS" "$TASK_FILE"
exit $RESULT
