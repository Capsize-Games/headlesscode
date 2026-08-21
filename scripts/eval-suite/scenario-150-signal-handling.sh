#!/usr/bin/env bash
set -uo pipefail

# Live eval for issue #150's fix (process-level SIGTERM/uncaughtException/
# unhandledRejection handlers in cli.ts): spawns a REAL session against the
# code-daemon, sends it a real SIGTERM mid-run, and verifies the log file's
# LAST line is the handler's own "SIGTERM received" message — not silence.
# This is exactly the observability gap #150 described: before the fix,
# this same test would have shown a log file that just stops, with no
# trace the process ever received anything.
#
# Does NOT cover the SIGKILL/OOM case (#150's harder, still-open half) —
# SIGKILL is uncatchable by definition, so no userspace handler can ever
# close that gap; only a separate spawn-layer watchdog could.
#
# Usage: scripts/eval-suite/scenario-150-signal-handling.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
WS="$(mktemp -d "${TMPDIR:-/tmp}/headlesscode-eval-150-XXXXXX")"
LOG="$REPO_ROOT/.headlesscode/scratch/eval-suite/150-signal-$STAMP.log"
mkdir -p "$REPO_ROOT/.headlesscode/scratch/eval-suite"

cd "$WS"
git init -q
git config user.email "eval@local"
git config user.name "eval"
echo "hello" > a.txt
git add -A && git commit -q -m "initial fixture"

TASK_FILE="${TMPDIR:-/tmp}/headlesscode-eval-150-task-$STAMP.md"
cat > "$TASK_FILE" <<'EOF'
## Rules
- Unattended: never use ask_followup_question.

## Task
List the files in this directory, then list them again with more detail,
then wait a moment before deciding what to do next. Do not rush to finish.
EOF

echo "Workspace: $WS"
echo "Log file:  $LOG"
echo "--- spawning a real session against the code-daemon (qwen3-14b) ---"

cd "$REPO_ROOT"
HEADLESSCODE_CODE_MODE_BACKEND=ollama \
HEADLESSCODE_LOCAL_BACKEND_MODES=code \
HEADLESSCODE_OLLAMA_URL=http://localhost:11435 \
HEADLESSCODE_CODE_MODE_MODEL=qwen3-14b:latest \
npx tsx src/cli.ts \
	--mode code \
	--task-file "$TASK_FILE" \
	--workspace "$WS" \
	--max-iterations 30 \
	--log-file "$LOG" \
	> "$LOG.stdout" 2>&1 &
WRAPPER_PID=$!

# Wait for the LOG FILE to exist, not just a matching process — pgrep
# matches on command-line args, which are set from process start, before
# the process has actually reached logger/handler registration in
# main(). The log file is only created once that point is reached
# ("[cli] session process started" is the first line logger.info writes),
# so waiting for it is a precise proxy for "handlers are now registered."
for _ in $(seq 1 50); do
	if [ -s "$LOG" ]; then
		break
	fi
	sleep 0.1
done

REAL_PID="$(pgrep -f "src/cli.ts.*--workspace $WS" | sort -n | tail -1)"

if [ -z "$REAL_PID" ]; then
	echo "FAIL: could not find the real session process within 5s." >&2
	kill -9 "$WRAPPER_PID" 2>/dev/null
	exit 1
fi

echo "Real session PID: $REAL_PID — sending SIGTERM"
kill -TERM "$REAL_PID"

# Give the handler a moment to log + exit, then confirm.
for _ in $(seq 1 20); do
	if ! kill -0 "$REAL_PID" 2>/dev/null; then
		break
	fi
	sleep 0.2
done
kill -9 "$WRAPPER_PID" 2>/dev/null

echo ""
echo "--- last log line ---"
tail -1 "$LOG" 2>/dev/null

if grep -q "SIGTERM received" "$LOG" 2>/dev/null; then
	echo ""
	echo "PASS: log captured the SIGTERM — no silent death."
	RESULT=0
else
	echo ""
	echo "FAIL: log does NOT show a SIGTERM record — this is exactly #150's silent-death shape."
	RESULT=1
fi

rm -rf "$WS" "$TASK_FILE"
exit $RESULT
