#!/usr/bin/env bash
#
# run.sh — headlesscode Phase 1 end-to-end integration test.
#
# Exercises the REAL CLI (src/cli.ts) through the REAL HTTP path against a
# local mock OpenRouter server (no API key, no network) inside an isolated git
# worktree of a throwaway fixture repo — mirroring the project's
# ".worktrees/ per session" isolation pattern.
#
# What it verifies end-to-end (success scenario):
#   1. CLI exits 0.
#   2. The attempt_completion result is on stdout and in the log file.
#   3. The worktree's buggy file now contains the fix (mock derives the fix
#      content from the fixture, so this is a byte-for-byte assertion).
#   4. The fixture repo (the source of the worktree) is untouched — git status
#      clean there.
#   5. The mock server saw >= 3 requests with strictly increasing message
#      counts (the loop's history is really growing across LLM calls).
#   6. Rules splicing + custom-mode loading work (via two --dry-run passes
#      before the real run).
#
# Usage: scripts/e2e/run.sh
#   KEEP=1            keep fixture/worktree temp dirs (default: remove)
#   MOCK_SCENARIO     success (default) | error-loop
#                     error-loop: the mock always returns an erroring tool call
#                     so the harness must hit its consecutive-mistake bound and
#                     the CLI must exit 1 (bounded failure end-to-end).
#
# Requires: node >= 18, npm/npx with tsx installed (npm install), git >= 2.28.
# No API key and no network access needed.
#
# Exit code: 0 = PASS, 1 = FAIL.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCENARIO="${MOCK_SCENARIO:-success}"
KEEP="${KEEP:-0}"

PASS=0
FAIL=0
fail() { FAIL=$((FAIL + 1)); echo "  FAIL  $*"; }
pass() { PASS=$((PASS + 1)); echo "  ok    $*"; }

cleanup() {
	if [ "$KEEP" = "1" ]; then
		echo "  KEEP=1: leaving fixture ($FIXTURE), worktree ($WORKTREE), and logs in place"
		return
	fi
	if [ -n "${MOCK_PID:-}" ]; then
		kill "$MOCK_PID" 2>/dev/null || true
		wait "$MOCK_PID" 2>/dev/null || true
	fi
	if [ -n "${FIXTURE:-}" ] && [ -n "${WORKTREE:-}" ]; then
		# Unregister the worktree from the fixture's admin dir before rm -rf.
		git -C "$FIXTURE" worktree remove --force "$WORKTREE" 2>/dev/null || true
	fi
	rm -rf "${FIXTURE:-}" "${WORKTREE:-}" \
		"${DRYRUN_CODE_OUT:-}" "${DRYRUN_MODE_OUT:-}" "${HARNESS_OUT:-}" "${MOCK_LOG:-}"
	echo "  cleaned up temp fixture/worktree/logs (set KEEP=1 to retain)"
}

# ── 1. Fixture repo ──────────────────────────────────────────────────────────
echo "== [1/7] fixture repo =="
FIXTURE="$(bash "$ROOT/scripts/e2e-fixture/setup.sh")"
if [ -z "$FIXTURE" ] || [ ! -d "$FIXTURE/.git" ]; then
	echo "  fixture setup failed; aborting" >&2
	exit 1
fi
echo "  fixture: $FIXTURE"

# ── 2. Isolated worktree (the harness works HERE, fixture stays untouched) ──
echo "== [2/7] isolated worktree =="
WORKTREE="$(mktemp -d /tmp/headlesscode-e2e-worktree-XXXXXX)"
bash "$ROOT/scripts/e2e-fixture/spawn-worktree.sh" "$FIXTURE" "$WORKTREE" >/dev/null
if ! git -C "$WORKTREE" rev-parse --git-dir >/dev/null 2>&1; then
	echo "  worktree spawn failed; aborting" >&2
	exit 1
fi
echo "  worktree: $WORKTREE"

# ── 3. Mock OpenRouter server on a random port ───────────────────────────────
echo "== [3/7] mock OpenRouter server =="
MOCK_LOG="$(mktemp /tmp/headlesscode-e2e-mock-XXXXXX.log)"
PORT="${E2E_MOCK_PORT:-0}" # 0 = OS-assigned random port; actual port read back below
(
	cd "$ROOT" &&
		exec env PORT="$PORT" MOCK_SCENARIO="$SCENARIO" MOCK_FIXTURE_ROOT="$FIXTURE" \
			node scripts/e2e/mock-openrouter.mjs
) >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!

MOCK_PORT=""
for _ in $(seq 1 100); do
	MOCK_PORT="$(sed -n 's/.*listening on http:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' "$MOCK_LOG" | head -n 1)"
	[ -n "$MOCK_PORT" ] && break
	if ! kill -0 "$MOCK_PID" 2>/dev/null; then
		echo "  mock server exited before listening; log:" >&2
		cat "$MOCK_LOG" >&2
		exit 1
	fi
	sleep 0.1
done

if [ -z "$MOCK_PORT" ]; then
	echo "  mock server did not become ready; log:" >&2
	cat "$MOCK_LOG" >&2
	kill "$MOCK_PID" 2>/dev/null || true
	exit 1
fi
echo "  mock listening on 127.0.0.1:$MOCK_PORT (pid $MOCK_PID, scenario=$SCENARIO)"
sleep 0.2

# ── 4. Dry-run validation (rules splicing + custom modes, no LLM) ────────────
echo "== [4/7] dry-run validation (rules + custom modes) =="
DRYRUN_CODE_OUT="$(mktemp /tmp/headlesscode-e2e-dryrun-code-XXXXXX.out)"
(
	cd "$ROOT" &&
		npx --no-install tsx src/cli.ts --dry-run --mode code --workspace "$WORKTREE"
) >"$DRYRUN_CODE_OUT" 2>&1
DRYRUN_CODE_EXIT=$?
if [ "$DRYRUN_CODE_EXIT" -eq 0 ] &&
	grep -q "MODE RULE (code)" "$DRYRUN_CODE_OUT" &&
	grep -q "GENERIC RULE" "$DRYRUN_CODE_OUT" &&
	grep -q "AGENT RULE" "$DRYRUN_CODE_OUT"; then
	pass "dry-run (code): rules-code + rules + AGENTS.md all spliced (exit $DRYRUN_CODE_EXIT)"
else
	fail "dry-run (code): expected exit 0 with MODE RULE (code) + GENERIC RULE + AGENT RULE (exit $DRYRUN_CODE_EXIT)"
fi

DRYRUN_MODE_OUT="$(mktemp /tmp/headlesscode-e2e-dryrun-mode-XXXXXX.out)"
(
	cd "$ROOT" &&
		npx --no-install tsx src/cli.ts --dry-run --mode issue-fixer --workspace "$WORKTREE"
) >"$DRYRUN_MODE_OUT" 2>&1
DRYRUN_MODE_EXIT=$?
if [ "$DRYRUN_MODE_EXIT" -eq 0 ] && grep -q "issue-fixer" "$DRYRUN_MODE_OUT"; then
	pass "dry-run (issue-fixer): custom mode loaded from .roomodes (exit $DRYRUN_MODE_EXIT)"
else
	fail "dry-run (issue-fixer): expected exit 0 with custom mode 'issue-fixer' (exit $DRYRUN_MODE_EXIT)"
fi

# ── 5. Real harness run (real CLI + real HTTP against the mock) ──────────────
echo "== [5/7] harness run (real CLI, real HTTP, mock LLM) =="
HARNESS_LOG="/tmp/headlesscode-e2e.log"
HARNESS_OUT="$(mktemp /tmp/headlesscode-e2e-cli-XXXXXX.out)"
TASK_TEXT='fix the greet function in src/greet.js so it returns "Hello, " + name (issue #29)'

(
	cd "$ROOT" &&
		OPENROUTER_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
		HEADLESSCODE_OPENROUTER_API_KEY="test-key" \
		HEADLESSCODE_WORKSPACE_ROOT="$WORKTREE" \
		npx --no-install tsx src/cli.ts --task "$TASK_TEXT" --mode code \
			--workspace "$WORKTREE" --max-iterations 10 --log-file "$HARNESS_LOG"
) >"$HARNESS_OUT" 2>&1
CLI_EXIT=$?
echo "  cli exit code: $CLI_EXIT"

# ── 6. Assertions ────────────────────────────────────────────────────────────
echo "== [6/7] assertions =="

if [ "$SCENARIO" = "error-loop" ]; then
	# Bounded-failure path: the CLI must exit 1 after consecutive mistakes.
	if [ "$CLI_EXIT" -eq 1 ]; then
		pass "error-loop: CLI exited 1 (bounded failure)"
	else
		fail "error-loop: expected CLI exit 1, got $CLI_EXIT"
	fi
	if grep -q "Bounded failure" "$HARNESS_OUT" "$HARNESS_LOG" 2>/dev/null; then
		pass "error-loop: 'Bounded failure' message present"
	else
		fail "error-loop: expected 'Bounded failure' in CLI output/log"
	fi
else
	if [ "$CLI_EXIT" -eq 0 ]; then
		pass "CLI exited 0"
	else
		fail "CLI exited $CLI_EXIT (expected 0); output tail:"
		tail -n 25 "$HARNESS_OUT" >&2
	fi

	if grep -q "issue #29" "$HARNESS_OUT"; then
		pass "attempt_completion result on stdout (mentions issue #29)"
	else
		fail "expected the attempt_completion result (issue #29) in CLI output"
	fi

	if grep -q "attempt_completion received" "$HARNESS_LOG"; then
		pass "attempt_completion logged"
	else
		fail "expected 'attempt_completion received' in $HARNESS_LOG"
	fi

	if grep -q 'return "Hello, " + name' "$WORKTREE/src/greet.js" && ! grep -q '// BUG' "$WORKTREE/src/greet.js"; then
		pass "worktree src/greet.js contains the fix"
	else
		fail "worktree src/greet.js does not contain the expected fix"
	fi

	if [ -z "$(git -C "$FIXTURE" status --porcelain)" ]; then
		pass "fixture repo is clean (untouched by the worktree session)"
	else
		fail "fixture repo is dirty: $(git -C "$FIXTURE" status --porcelain)"
	fi
fi

# ── 7. Mock request-log assertions (count + growing history) ─────────────────
echo "== [7/7] mock request log =="
REQ_COUNT="$(grep -c '\[mock\] request #' "$MOCK_LOG" || true)"
echo "  requests seen: $REQ_COUNT"

if [ "$SCENARIO" = "error-loop" ]; then
	if [ "$REQ_COUNT" -ge 3 ]; then
		pass "mock saw >= 3 requests ($REQ_COUNT)"
	else
		fail "mock saw only $REQ_COUNT requests (expected >= 3)"
	fi
else
	if [ "$REQ_COUNT" -ge 3 ]; then
		pass "mock saw >= 3 requests ($REQ_COUNT)"
	else
		fail "mock saw only $REQ_COUNT requests (expected >= 3: read, write+verify, completion)"
	fi

	# Message counts must strictly increase across requests: the loop's history
	# grows as tool results are fed back.
	COUNTS="$(grep '\[mock\] request #' "$MOCK_LOG" | sed -n 's/.*messages=\([0-9]*\).*/\1/p')"
	PREV=0
	MONO=1
	IDX=0
	for c in $COUNTS; do
		IDX=$((IDX + 1))
		if [ "$c" -le "$PREV" ]; then
			MONO=0
			echo "  message counts not increasing at request #$IDX ($PREV -> $c)" >&2
		fi
		PREV="$c"
	done
	if [ "$MONO" -eq 1 ]; then
		pass "history grows across requests ($(echo "$COUNTS" | tr '\n' ' '))"
	else
		fail "history does not strictly grow ($(echo "$COUNTS" | tr '\n' ' '))"
	fi
fi

# ── Summary + cleanup ────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo ""
echo "──────────────────────────────────────────────────────────────"
echo "  scenario:       $SCENARIO"
echo "  fixture:        $FIXTURE"
echo "  worktree:       $WORKTREE"
echo "  mock port:      $MOCK_PORT"
echo "  cli exit code:  $CLI_EXIT"
echo "  requests seen:  $REQ_COUNT"
echo "  results:        PASS $PASS / $TOTAL   FAIL $FAIL / $TOTAL"
if [ "$FAIL" -eq 0 ]; then
	echo "  RESULT: PASS"
else
	echo "  RESULT: FAIL"
fi
echo "  harness output: $HARNESS_OUT"
echo "  harness log:    $HARNESS_LOG"
echo "  mock log:       $MOCK_LOG"
echo "──────────────────────────────────────────────────────────────"
cleanup

[ "$FAIL" -eq 0 ]
