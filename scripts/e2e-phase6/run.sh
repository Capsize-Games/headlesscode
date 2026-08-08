#!/usr/bin/env bash
#
# run.sh — headlesscode Phase 6 end-to-end integration test (guardrails:
# per-session budget + global concurrency cap). No real GitHub, no real API
# key, no real LLM, no live cloud.
#
# What is exercised (the REAL code paths end-to-end):
#   1. BUDGET ABORT: run the REAL `headlesscode` CLI against the mock
#      OpenRouter server (success scenario) with HEADLESSCODE_MAX_COST_USD
#      tiny. The session starts (first LLM call happens), the usage tokens
#      flow back, the cost budget trips, the session aborts with reason
#      "budget", the CLI prints the budgetUsage line + "aborted by budget"
#      and exits 1. A control run WITHOUT the budget completes successfully
#      (exit 0) — proving it was the budget that aborted the run.
#   2. CONCURRENCY-CAP SWEEP: the REAL watcher against the fake GitHub server
#      with a 3-issue label storm and --max-concurrent-sessions 2 (stubbed
#      spawner): exactly 2 spawned, the third stays 'pending' in watcher
#      state (the global cap defers it, exactly like maxPerSweep overflow).
#
# What is stubbed (documented deviation, matching the Phase 5 e2e pattern):
#   - scripts/e2e/mock-openrouter.mjs  — fake OpenRouter (usage tokens per
#     request: 16 prompt + 24 completion).
#   - scripts/e2e-phase5/mock-github.mjs — fake GitHub REST server.
#   - The spawner script via HEADLESSCODE_SPAWN_SCRIPT (a stub that creates
#     .worktrees/<name>/ + appends a .spawn-invoked marker). No real git
#     worktrees, no real harness workers, no cloud resources.
#
# Usage: scripts/e2e-phase6/run.sh
#   KEEP=1   keep temp fixture/logs (default: remove)
#
# Requires: node >= 18, npm/npx with tsx (npm install), git >= 2.28, bash.
# Exit code: 0 = PASS, 1 = FAIL.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEEP="${KEEP:-0}"

PASS=0
FAIL=0
fail() { FAIL=$((FAIL + 1)); echo "  FAIL  $*"; }
pass() { PASS=$((PASS + 1)); echo "  ok    $*"; }

MOCK_PIDS=""

cleanup() {
	if [ "$KEEP" = "1" ]; then
		echo "  KEEP=1: leaving fixture/logs in place"
		return
	fi
	for p in $MOCK_PIDS; do
		kill "$p" 2>/dev/null || true
		wait "$p" 2>/dev/null || true
	done
	rm -rf "${FIXTURE:-}" \
		"${LLM_LOG:-}" "${LLM_PORT_VAR:-}" \
		"${CONTROL_OUT:-}" "${BUDGET_OUT:-}" \
		"${GH_LOG:-}" "${CAP_OUT:-}" \
		"${ISSUES_STORM:-}" "${SPAWN_STUB:-}"
	echo "  cleaned up temp fixture/logs (set KEEP=1 to retain)"
}

# Start a mock server; waits until it prints its port and stores it in $2.
start_mock() {
	local cmd="$1"
	local logfile="$2"
	local portvar="$3"
	( cd "$ROOT" && env PORT=0 $cmd ) >"$logfile" 2>&1 &
	local pid=$!
	MOCK_PIDS="$MOCK_PIDS $pid"

	local port=""
	for _ in $(seq 1 100); do
		port="$(sed -n 's/.*listening on http:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' "$logfile" | head -n 1)"
		[ -n "$port" ] && break
		if ! kill -0 "$pid" 2>/dev/null; then
			echo "  mock exited before listening; log:" >&2
			cat "$logfile" >&2
			exit 1
		fi
		sleep 0.1
	done
	if [ -z "$port" ]; then
		echo "  mock did not become ready; log:" >&2
		cat "$logfile" >&2
		exit 1
	fi
	printf -v "$portvar" '%s' "$port"
	echo "  mock on 127.0.0.1:$port (pid $pid)"
}

kill_mock() {
	for p in $MOCK_PIDS; do
		kill "$p" 2>/dev/null || true
		wait "$p" 2>/dev/null || true
	done
	MOCK_PIDS=""
}

# ── 1. Fixture repo ──────────────────────────────────────────────────────────
echo "== [1/6] fixture repo =="
FIXTURE="$(bash "$ROOT/scripts/e2e-fixture/setup.sh")"
if [ -z "$FIXTURE" ] || [ ! -d "$FIXTURE/.git" ]; then
	echo "  fixture setup failed; aborting" >&2
	exit 1
fi
echo "  fixture: $FIXTURE"

# ── 2. Part A — budget abort (mock OpenRouter, success scenario) ────────────
echo "== [2/6] budget abort vs mock OpenRouter =="
LLM_LOG="$(mktemp /tmp/headlesscode-e2e6-llm-XXXXXX.log)"
start_mock "MOCK_SCENARIO=success MOCK_FIXTURE_ROOT=$FIXTURE node scripts/e2e/mock-openrouter.mjs" "$LLM_LOG" LLM_PORT
sleep 0.2

# Control run WITHOUT a budget: the success scenario completes (exit 0).
CONTROL_OUT="$(mktemp /tmp/headlesscode-e2e6-control-XXXXXX.out)"
(
	cd "$ROOT" &&
		HEADLESSCODE_OPENROUTER_API_KEY="test" \
		OPENROUTER_BASE_URL="http://127.0.0.1:$LLM_PORT" \
		npx tsx src/cli.ts --task "Fix the greet bug" --workspace "$FIXTURE"
) >"$CONTROL_OUT" 2>&1
CONTROL_EXIT=$?
if [ "$CONTROL_EXIT" -eq 0 ] && grep -q "Hello" "$CONTROL_OUT"; then
	pass "control run (no budget) completes successfully (exit $CONTROL_EXIT)"
else
	fail "control run should succeed without a budget (exit $CONTROL_EXIT)"
	tail -n 15 "$CONTROL_OUT" >&2
fi

# Budgeted run: tiny per-session cost cap (via env, as run-worker.sh would).
# The session uses the harness DEFAULT model (deepseek/deepseek-v4-flash-0731 =
# $0.14/1M in + $0.28/1M out — see DEFAULT_MODEL in src/llm/openrouter.ts);
# one mock call is 16 in + 24 out ≈ $0.00000896, so a $0.000005 cap means the
# FIRST recorded call trips the budget.
BUDGET_OUT="$(mktemp /tmp/headlesscode-e2e6-budget-XXXXXX.out)"
(
	cd "$ROOT" &&
		HEADLESSCODE_OPENROUTER_API_KEY="test" \
		OPENROUTER_BASE_URL="http://127.0.0.1:$LLM_PORT" \
		HEADLESSCODE_MAX_COST_USD="0.000005" \
		npx tsx src/cli.ts --task "Fix the greet bug" --workspace "$FIXTURE"
) >"$BUDGET_OUT" 2>&1
BUDGET_EXIT=$?
if [ "$BUDGET_EXIT" -eq 1 ]; then
	pass "budgeted run exits 1 when the cost cap trips (exit $BUDGET_EXIT)"
else
	fail "budgeted run should exit 1 (got $BUDGET_EXIT)"
	tail -n 15 "$BUDGET_OUT" >&2
fi
if grep -qi "budget" "$BUDGET_OUT"; then
	pass "output mentions the budget abort"
else
	fail "output missing the budget abort message"
	cat "$BUDGET_OUT" >&2
fi
if grep -q '\[budget\] cost \$' "$BUDGET_OUT"; then
	pass "budgetUsage surfaced on stdout ([budget] cost \$...)"
else
	fail "missing [budget] usage line"
	cat "$BUDGET_OUT" >&2
fi

# ── 3. Part B — concurrency-cap sweep (fake GitHub + stubbed spawner) ───────
echo "== [3/6] stub spawner + 3-issue storm fixture =="
SPAWN_STUB="$(mktemp /tmp/headlesscode-e2e6-spawn-XXXXXX.sh)"
cat > "$SPAWN_STUB" <<'EOF'
#!/usr/bin/env bash
# STUB spawner for the Phase 6 e2e — see scripts/e2e-phase6/run.sh.
set -u
REPO="${TARGET_REPO:-$(pwd)}"
if [ "$#" -eq 0 ]; then
	echo "stub-spawn: usage error (no specs)" >&2
	exit 1
fi
for spec in "$@"; do
	name="$(printf '%s' "$spec" | cut -d: -f1)"
	task_file="$(printf '%s' "$spec" | cut -d: -f3-)"
	mkdir -p "$REPO/.worktrees/$name"
	printf '%s %s %s\n' "$name" "$task_file" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$REPO/.worktrees/.spawn-invoked"
	echo "stub-spawn: $name ($task_file)"
done
exit 0
EOF
chmod +x "$SPAWN_STUB"

ISSUES_STORM="$(mktemp /tmp/headlesscode-e2e6-storm-XXXXXX.json)"
cat > "$ISSUES_STORM" <<'EOF'
[
  {
    "number": 201,
    "title": "Add auth token validation to the request handler",
    "body": "hot path: auth + request handling",
    "labels": [{ "name": "needs-agent" }],
    "updated_at": "2026-08-01T00:00:00Z",
    "html_url": "https://github.com/acme/widget/issues/201"
  },
  {
    "number": 202,
    "title": "Split utils.py into focused modules",
    "body": "",
    "labels": [{ "name": "needs-agent" }],
    "updated_at": "2026-08-01T00:00:00Z",
    "html_url": "https://github.com/acme/widget/issues/202"
  },
  {
    "number": 203,
    "title": "Decompose models.py into focused files",
    "body": "",
    "labels": [{ "name": "needs-agent" }],
    "updated_at": "2026-08-01T00:00:00Z",
    "html_url": "https://github.com/acme/widget/issues/203"
  }
]
EOF

# ── 4. Cap sweep run: 3 issues, cap 2 -> 2 spawned, 1 pending ───────────────
echo "== [4/6] watcher sweep with --max-concurrent-sessions 2 =="
kill_mock
GH_LOG="$(mktemp /tmp/headlesscode-e2e6-gh-XXXXXX.log)"
start_mock "MOCK_ISSUES_FILE=$ISSUES_STORM node scripts/e2e-phase5/mock-github.mjs" "$GH_LOG" GH_PORT
sleep 0.2

CAP_OUT="$(mktemp /tmp/headlesscode-e2e6-cap-XXXXXX.out)"
(
	cd "$ROOT" &&
		GH_TOKEN="test" \
		GITHUB_API_BASE_URL="http://127.0.0.1:$GH_PORT" \
		HEADLESSCODE_SPAWN_SCRIPT="$SPAWN_STUB" \
		npx tsx src/cli.ts watch --owner acme --repo "$FIXTURE" --label needs-agent \
			--run-once --max-concurrent-sessions 2 --max-per-sweep 5
) >"$CAP_OUT" 2>&1
CAP_EXIT=$?
STATE_FILE="$FIXTURE/.worktrees/.watcher-state.json"
echo "  cap sweep exit: $CAP_EXIT"
if [ "$CAP_EXIT" -eq 0 ] && grep -q "2 spawned" "$CAP_OUT" && grep -q "1 deferred" "$CAP_OUT"; then
	pass "cap sweep spawned 2 and deferred 1 (global cap respected)"
else
	fail "cap sweep should spawn 2 + defer 1 (exit $CAP_EXIT)"
	tail -n 20 "$CAP_OUT" >&2
fi
SPAWN_LINES="$(wc -l < "$FIXTURE/.worktrees/.spawn-invoked" 2>/dev/null || echo 0)"
if [ "$SPAWN_LINES" -eq 2 ]; then
	pass "spawner invoked exactly twice"
else
	fail "expected exactly 2 spawn invocations, got $SPAWN_LINES"
	[ -f "$FIXTURE/.worktrees/.spawn-invoked" ] && cat "$FIXTURE/.worktrees/.spawn-invoked" >&2 || true
fi
if [ -f "$STATE_FILE" ] &&
	grep -q '"201"' "$STATE_FILE" && grep -q '"status": "done"' "$STATE_FILE" &&
	grep -q '"202"' "$STATE_FILE" && grep -q '"status": "pending"' "$STATE_FILE" &&
	grep -q '"203"' "$STATE_FILE" && grep -q '"status": "pending"' "$STATE_FILE"; then
	pass "watcher state: 1 issue done + 2 pending (cap-exceeding issues stay pending)"
else
	fail "watcher state shape wrong after the cap sweep"
	[ -f "$STATE_FILE" ] && cat "$STATE_FILE" >&2 || true
fi

# ── 5. Missing token -> clear error (guardrail hygiene unchanged) ────────────
echo "== [5/6] missing GH_TOKEN =="
NOTOKEN_OUT="$(mktemp /tmp/headlesscode-e2e6-notoken-XXXXXX.out)"
(
	cd "$ROOT" &&
		env -u GH_TOKEN -u GITHUB_TOKEN \
			GITHUB_API_BASE_URL="http://127.0.0.1:$GH_PORT" \
			npx tsx src/cli.ts watch --owner acme --repo "$FIXTURE" --label needs-agent --run-once
) >"$NOTOKEN_OUT" 2>&1
NOTOKEN_EXIT=$?
if [ "$NOTOKEN_EXIT" -eq 2 ] && grep -q "GH_TOKEN" "$NOTOKEN_OUT"; then
	pass "missing token -> clear error, exit 2"
else
	fail "missing token should error clearly (exit $NOTOKEN_EXIT)"
	tail -n 10 "$NOTOKEN_OUT" >&2
fi

# ── 6. Summary + cleanup ─────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo ""
echo "──────────────────────────────────────────────────────────────"
echo "  fixture:      $FIXTURE"
echo "  results:      PASS $PASS / $TOTAL   FAIL $FAIL / $TOTAL"
if [ "$FAIL" -eq 0 ]; then
	echo "  RESULT: PASS"
else
	echo "  RESULT: FAIL"
fi
echo "──────────────────────────────────────────────────────────────"
cleanup

[ "$FAIL" -eq 0 ]
