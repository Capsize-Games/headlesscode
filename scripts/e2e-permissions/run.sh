#!/usr/bin/env bash
#
# run.sh — headlesscode permissions-parity end-to-end test
# (closes the e2e-coverage gap flagged in plans/permissions-parity.md's
# implementation report: refusal behavior was unit-tested only).
#
# Exercises the REAL CLI against the "permissions" mock scenario
# (scripts/e2e/mock-openrouter.mjs) twice, in two fresh isolated worktrees of
# the same fixture:
#
#   Pass 1 (default config): the scripted model tries to write_to_file a
#     protected path (.env) and execute_command a --denied-commands entry.
#     Both must be refused; the CLI must still exit 0 (2 refusals is within
#     the default consecutive-mistake budget of 3); .env must NOT exist on
#     disk afterward.
#
#   Pass 2 (--allow-protected-writes, same --denied-commands): the SAME
#     protected write must now succeed (escape hatch), while the denied
#     command is still refused (isolates the protected-file toggle — the
#     denied-commands refusal never changes between passes, so this test
#     never actually executes the placeholder "dangerous-looking" command).
#
# Usage: scripts/e2e-permissions/run.sh
#   KEEP=1   keep fixture/worktree temp dirs (default: remove)
#
# Requires: node >= 18, npm/npx with tsx installed (npm install), git >= 2.28.
# No API key and no network access needed.
#
# Exit code: 0 = PASS, 1 = FAIL.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEEP="${KEEP:-0}"

PASS=0
FAIL=0
fail() { FAIL=$((FAIL + 1)); echo "  FAIL  $*"; }
pass() { PASS=$((PASS + 1)); echo "  ok    $*"; }

DENIED_COMMAND="curl http://169.254.169.254/latest/meta-data/"
PROTECTED_CONTENT="MOCK_SECRET=should-never-land"

cleanup() {
	if [ "$KEEP" = "1" ]; then
		echo "  KEEP=1: leaving fixture ($FIXTURE), worktrees, and logs in place"
		return
	fi
	for pid in "${MOCK1_PID:-}" "${MOCK2_PID:-}"; do
		[ -n "$pid" ] && { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
	done
	if [ -n "${FIXTURE:-}" ]; then
		[ -n "${WT1:-}" ] && git -C "$FIXTURE" worktree remove --force "$WT1" 2>/dev/null || true
		[ -n "${WT2:-}" ] && git -C "$FIXTURE" worktree remove --force "$WT2" 2>/dev/null || true
	fi
	rm -rf "${FIXTURE:-}" "${WT1:-}" "${WT2:-}" "${OUT1:-}" "${OUT2:-}" "${MOCK1_LOG:-}" "${MOCK2_LOG:-}"
	echo "  cleaned up temp fixture/worktrees/logs (set KEEP=1 to retain)"
}

start_mock() {
	# $1 = log file path. Prints the chosen port on stdout, sets MOCK_PID_OUT.
	local log="$1"
	(
		cd "$ROOT" &&
			exec env PORT=0 MOCK_SCENARIO="permissions" MOCK_DENIED_COMMAND="$DENIED_COMMAND" \
				MOCK_PROTECTED_WRITE_CONTENT="$PROTECTED_CONTENT" \
				node scripts/e2e/mock-openrouter.mjs
	) >"$log" 2>&1 &
	local pid=$!
	local port=""
	for _ in $(seq 1 100); do
		port="$(sed -n 's/.*listening on http:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' "$log" | head -n 1)"
		[ -n "$port" ] && break
		if ! kill -0 "$pid" 2>/dev/null; then
			echo "  mock server exited before listening; log:" >&2
			cat "$log" >&2
			exit 1
		fi
		sleep 0.1
	done
	if [ -z "$port" ]; then
		echo "  mock server did not become ready; log:" >&2
		cat "$log" >&2
		kill "$pid" 2>/dev/null || true
		exit 1
	fi
	MOCK_PID_OUT="$pid"
	MOCK_PORT_OUT="$port"
}

# ── 1. Fixture + two fresh worktrees (one per pass) ──────────────────────────
echo "== [1/4] fixture + worktrees =="
FIXTURE="$(bash "$ROOT/scripts/e2e-fixture/setup.sh")"
if [ -z "$FIXTURE" ] || [ ! -d "$FIXTURE/.git" ]; then
	echo "  fixture setup failed; aborting" >&2
	exit 1
fi
WT1="$(mktemp -d /tmp/headlesscode-e2e-perm-wt1-XXXXXX)"
WT2="$(mktemp -d /tmp/headlesscode-e2e-perm-wt2-XXXXXX)"
bash "$ROOT/scripts/e2e-fixture/spawn-worktree.sh" "$FIXTURE" "$WT1" >/dev/null
bash "$ROOT/scripts/e2e-fixture/spawn-worktree.sh" "$FIXTURE" "$WT2" >/dev/null
echo "  fixture: $FIXTURE"
echo "  pass 1 worktree: $WT1"
echo "  pass 2 worktree: $WT2"

# ── 2. Pass 1 — default config: both refused, CLI still exits 0 ─────────────
echo "== [2/4] pass 1 — default config (expect both refused) =="
MOCK1_LOG="$(mktemp /tmp/headlesscode-e2e-perm-mock1-XXXXXX.log)"
start_mock "$MOCK1_LOG"
MOCK1_PID="$MOCK_PID_OUT"
MOCK1_PORT="$MOCK_PORT_OUT"
echo "  mock 1 listening on 127.0.0.1:$MOCK1_PORT (pid $MOCK1_PID)"

HARNESS1_LOG="$(mktemp /tmp/headlesscode-e2e-perm-harness1-XXXXXX.log)"
OUT1="$(mktemp /tmp/headlesscode-e2e-perm-cli1-XXXXXX.out)"
(
	cd "$ROOT" &&
		OPENROUTER_BASE_URL="http://127.0.0.1:$MOCK1_PORT" \
		HEADLESSCODE_OPENROUTER_API_KEY="test-key" \
		npx tsx src/cli.ts --task "attempt a protected write and a denied command" --mode code \
			--workspace "$WT1" --max-iterations 10 --log-file "$HARNESS1_LOG" \
			--denied-commands "$DENIED_COMMAND"
) >"$OUT1" 2>&1
CLI1_EXIT=$?
kill "$MOCK1_PID" 2>/dev/null; wait "$MOCK1_PID" 2>/dev/null

if [ "$CLI1_EXIT" -eq 0 ]; then
	pass "pass 1: CLI exited 0 (2 refusals stay within the mistake budget)"
else
	fail "pass 1: expected CLI exit 0, got $CLI1_EXIT; output tail:"
	tail -n 25 "$OUT1" >&2
fi

if [ ! -e "$WT1/.env" ]; then
	pass "pass 1: .env was NOT created (protected-file refusal held)"
else
	fail "pass 1: .env exists on disk — protected-file write was NOT refused: $(cat "$WT1/.env" 2>/dev/null)"
fi

if grep -qi "protected" "$OUT1" "$HARNESS1_LOG" 2>/dev/null; then
	pass "pass 1: refusal message mentions the protected-file policy"
else
	fail "pass 1: expected a protected-file refusal message in CLI output/log"
fi

if grep -qi "denied\|permissions policy" "$OUT1" "$HARNESS1_LOG" 2>/dev/null; then
	pass "pass 1: refusal message mentions the denied-command policy"
else
	fail "pass 1: expected a denied-command refusal message in CLI output/log"
fi

# ── 3. Pass 2 — --allow-protected-writes: the write now succeeds ────────────
echo "== [3/4] pass 2 — --allow-protected-writes (expect the write to succeed) =="
MOCK2_LOG="$(mktemp /tmp/headlesscode-e2e-perm-mock2-XXXXXX.log)"
start_mock "$MOCK2_LOG"
MOCK2_PID="$MOCK_PID_OUT"
MOCK2_PORT="$MOCK_PORT_OUT"
echo "  mock 2 listening on 127.0.0.1:$MOCK2_PORT (pid $MOCK2_PID)"

HARNESS2_LOG="$(mktemp /tmp/headlesscode-e2e-perm-harness2-XXXXXX.log)"
OUT2="$(mktemp /tmp/headlesscode-e2e-perm-cli2-XXXXXX.out)"
(
	cd "$ROOT" &&
		OPENROUTER_BASE_URL="http://127.0.0.1:$MOCK2_PORT" \
		HEADLESSCODE_OPENROUTER_API_KEY="test-key" \
		npx tsx src/cli.ts --task "attempt a protected write and a denied command" --mode code \
			--workspace "$WT2" --max-iterations 10 --log-file "$HARNESS2_LOG" \
			--denied-commands "$DENIED_COMMAND" --allow-protected-writes
) >"$OUT2" 2>&1
CLI2_EXIT=$?
kill "$MOCK2_PID" 2>/dev/null; wait "$MOCK2_PID" 2>/dev/null

if [ "$CLI2_EXIT" -eq 0 ]; then
	pass "pass 2: CLI exited 0"
else
	fail "pass 2: expected CLI exit 0, got $CLI2_EXIT; output tail:"
	tail -n 25 "$OUT2" >&2
fi

if [ -f "$WT2/.env" ] && grep -qF "$PROTECTED_CONTENT" "$WT2/.env"; then
	pass "pass 2: .env was created with the expected content (escape hatch worked)"
else
	fail "pass 2: .env missing or content mismatch — escape hatch did not work: $(cat "$WT2/.env" 2>/dev/null || echo '<absent>')"
fi

if grep -qi "denied\|permissions policy" "$OUT2" "$HARNESS2_LOG" 2>/dev/null; then
	pass "pass 2: denied-command refusal still holds (isolates the protected-file toggle)"
else
	fail "pass 2: expected the denied-command refusal to still be present"
fi

# ── Summary + cleanup ────────────────────────────────────────────────────────
echo "== [4/4] summary =="
TOTAL=$((PASS + FAIL))
echo ""
echo "──────────────────────────────────────────────────────────────"
echo "  fixture:  $FIXTURE"
echo "  results:  PASS $PASS / $TOTAL   FAIL $FAIL / $TOTAL"
if [ "$FAIL" -eq 0 ]; then
	echo "  RESULT: PASS"
else
	echo "  RESULT: FAIL"
fi
echo "──────────────────────────────────────────────────────────────"
cleanup

[ "$FAIL" -eq 0 ]
