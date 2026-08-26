#!/usr/bin/env bash
set -uo pipefail

# Live eval for issue #151: verifies DEFAULT_MAX_TOKENS request wiring
# (loop.ts:3072, unit-tested directly in loop.test.ts as of 02a11fa, CLI
# flag added in 90f8354 specifically to make this eval possible) actually
# reaches the real provider and has a real effect on live model output.
#
# maxTokens is a REQUEST-shaping value, not something a model can report
# on itself — there's no "the cap fired" tool-result message to grep for
# like the other #151 guardrails. Instead this is a COMPARATIVE eval: run
# the exact same simple task twice, once with the real default (32768)
# and once with an absurdly small --max-tokens (8) that cannot possibly
# hold a complete, valid tool call. If the flag's value is truly reaching
# the request, the tiny-budget run must behave differently — either a
# malformed/truncated tool call, a parse failure, or the session failing
# to make real progress — while the control run succeeds normally.
#
# PASS condition: the control run succeeds; the tiny-budget run does NOT
# succeed cleanly the same way (parse/format errors present, or it fails
# to complete within its iteration budget).
#
# KNOWN CURRENT FAILURE MODE (verified 2026-08-22, not a headlesscode
# bug): this eval currently FAILS against the local code-daemon because
# the daemon itself (the local code-daemon — a separate project/repo from
# headlesscode) silently ignores the Ollama-API num_predict option
# entirely. Confirmed by curling the daemon directly, bypassing
# headlesscode:
#   curl http://localhost:11435/api/chat -d '{"model":"qwen3-14b:latest",
#     "messages":[...],"options":{"num_predict":5}}'
# returned eval_count:20 (4x the requested limit) with done_reason:
# "stop" (a natural stop, not a length cutoff) — reproduced 2x with
# different limits/prompts. headlesscode's own wiring is independently
# verified correct: DEFAULT_MAX_TOKENS unit-tested directly (02a11fa),
# and src/llm/ollama.ts:106 correctly maps request.maxTokens to
# num_predict in the real outgoing request. This script will start
# passing once the daemon-side bug is fixed (or against any backend
# that actually honors the limit) — leaving it red on purpose rather
# than weakening the eval to hide a real, separate infrastructure gap.
#
# Usage: scripts/eval-suite/scenario-151-max-tokens.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

run_one () {
	local label="$1"
	local extra_flag="$2"
	local ws
	ws="$(mktemp -d "${TMPDIR:-/tmp}/headlesscode-eval-151mt-$label-XXXXXX")"
	local log="$REPO_ROOT/.headlesscode/scratch/eval-suite/151-max-tokens-$label-$STAMP.log"
	mkdir -p "$REPO_ROOT/.headlesscode/scratch/eval-suite"

	(
		cd "$ws"
		git init -q
		git config user.email "eval@local"
		git config user.name "eval"
		echo "hello" > a.txt
		git add -A && git commit -q -m "initial fixture"
	)

	local task_file="${TMPDIR:-/tmp}/headlesscode-eval-151mt-$label-task-$STAMP.md"
	cat > "$task_file" <<'EOF'
## Rules
- Unattended: never use ask_followup_question.
- CRITICAL: call exactly ONE tool per response, and nothing else in that
  same response.

## Task

Do these three steps, each as the SOLE tool call in its own separate
response:

1. Call write_to_file with path "note.txt" and content "done".
2. Call list_files with path ".".
3. Call attempt_completion with result "done", by itself.
EOF

	echo "=== $label run (extra flag: '$extra_flag') ===" >&2
	cd "$REPO_ROOT"
	# shellcheck disable=SC2086
	HEADLESSCODE_CODE_MODE_BACKEND=ollama \
	HEADLESSCODE_LOCAL_BACKEND_MODES=code \
	HEADLESSCODE_OLLAMA_URL=http://localhost:11435 \
	HEADLESSCODE_CODE_MODE_MODEL=qwen3-14b:latest \
	npx tsx src/cli.ts \
		--mode code \
		--task-file "$task_file" \
		--workspace "$ws" \
		--max-iterations 10 \
		$extra_flag \
		--log-file "$log" \
		> "$log.stdout" 2>&1
	local exit_code=$?

	local status="unknown"
	if grep -q "attempt_completion received — success" "$log" 2>/dev/null; then
		status="success"
	elif grep -q "bounded failure\|session failed" "$log" 2>/dev/null; then
		status="failed"
	fi
	# grep -c already prints "0" (and only exits 1) on zero matches — it
	# never actually errors, so a `|| echo 0` fallback here would append a
	# SECOND "0" line whenever the count is genuinely zero, corrupting this
	# function's single-line stdout contract. Just let grep -c's own output
	# stand; redirect stderr only in case the log file itself is missing.
	local malformed_count
	malformed_count="$(grep -c "recovered tool call written as text\|non-completing reply\|isError.:true" "$log" 2>/dev/null)"
	malformed_count="${malformed_count:-0}"

	echo "$status $malformed_count $ws $log"
	rm -f "$task_file"
}

echo "--- control run: real default max-tokens ---"
CONTROL_RESULT="$(run_one control "")"
CONTROL_STATUS="$(echo "$CONTROL_RESULT" | awk '{print $1}')"
CONTROL_MALFORMED="$(echo "$CONTROL_RESULT" | awk '{print $2}')"
CONTROL_WS="$(echo "$CONTROL_RESULT" | awk '{print $3}')"

echo ""
echo "--- tiny-budget run: --max-tokens 8 ---"
TINY_RESULT="$(run_one tiny "--max-tokens 8")"
TINY_STATUS="$(echo "$TINY_RESULT" | awk '{print $1}')"
TINY_MALFORMED="$(echo "$TINY_RESULT" | awk '{print $2}')"
TINY_WS="$(echo "$TINY_RESULT" | awk '{print $3}')"

echo ""
echo "=== results ==="
echo "control: status=$CONTROL_STATUS malformed_signals=$CONTROL_MALFORMED"
echo "tiny (--max-tokens 8): status=$TINY_STATUS malformed_signals=$TINY_MALFORMED"

RESULT=0

if [ "$CONTROL_STATUS" != "success" ]; then
	echo ""
	echo "FAIL: the control run (real default) did not succeed — cannot draw a comparison."
	RESULT=1
fi

if [ "$TINY_STATUS" = "success" ] && [ "$TINY_MALFORMED" -eq 0 ]; then
	echo ""
	echo "FAIL: --max-tokens 8 behaved identically to the default (clean success, no malformed-output signal)."
	echo "  Known cause as of 2026-08-22 (see header comment): the code-daemon itself ignores num_predict —"
	echo "  verified directly via curl, independent of headlesscode. Not evidence the CLI flag/wiring is broken."
	RESULT=1
else
	echo ""
	echo "PASS: --max-tokens 8 measurably changed live model behavior (status=$TINY_STATUS, malformed_signals=$TINY_MALFORMED) vs. the control's clean success — the flag is reaching the real request."
fi

rm -rf "$CONTROL_WS" "$TINY_WS"
exit $RESULT
