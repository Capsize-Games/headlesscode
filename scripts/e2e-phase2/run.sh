#!/usr/bin/env bash
#
# run.sh — headlesscode Phase 2 end-to-end integration test (orchestration
# layer). No API key, no network, no X server / xdotool / GUI.
#
# Exercises the REAL pieces of Phase 2 end-to-end:
#   1. `orchestrate --dry-run`: issues-json -> splitIssues (airunner
#      heuristics) -> split plan + exact spawn command printed.
#   2. scripts/spawn-parallel-worktrees.sh against a temp repo with 2 specs:
#      real worktrees, real per-worktree .env isolation overrides, real
#      ORCHESTRATOR_TASK.md copy, real background harness workers launched by
#      scripts/run-worker.sh against the mock OpenRouter server.
#   3. Completion: .harness.pid / .harness.exit / .harness.done markers appear;
#      .worktrees/.orchestrator-state.json gains 2 groups; workers actually
#      fixed the fixture bug (mock-derived, byte-for-byte assertable).
#   4. Review flow: runReview() runs as a SECOND harness session (read-only
#      tools only — the mock asserts write_to_file never appears) and
#      produces a verdict.
#
# Usage: scripts/e2e-phase2/run.sh
#   KEEP=1   keep temp fixture/bare/worktrees/logs (default: remove)
#
# Requires: node >= 18, npm/npx with tsx (npm install), git >= 2.28.
# Exit code: 0 = PASS, 1 = FAIL.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEEP="${KEEP:-0}"

PASS=0
FAIL=0
fail() { FAIL=$((FAIL + 1)); echo "  FAIL  $*"; }
pass() { PASS=$((PASS + 1)); echo "  ok    $*"; }

MOCK_PIDS=""
WORKTREE_NAMES=""

cleanup() {
	if [ "$KEEP" = "1" ]; then
		echo "  KEEP=1: leaving fixture ($FIXTURE), bare ($BARE), worktrees, and logs in place"
		return
	fi
	# Kill any still-running workers (by their .harness.pid files).
	if [ -n "${FIXTURE:-}" ]; then
		for n in $WORKTREE_NAMES; do
			pidfile="$FIXTURE/.worktrees/$n/.harness.pid"
			if [ -f "$pidfile" ]; then
				pid="$(cat "$pidfile" 2>/dev/null || true)"
				[ -n "$pid" ] && kill "$pid" 2>/dev/null || true
			fi
		done
	fi
	for p in $MOCK_PIDS; do
		kill "$p" 2>/dev/null || true
		wait "$p" 2>/dev/null || true
	done
	if [ -n "${FIXTURE:-}" ]; then
		for n in $WORKTREE_NAMES; do
			git -C "$FIXTURE" worktree remove --force "$FIXTURE/.worktrees/$n" 2>/dev/null || true
		done
	fi
	rm -rf "${FIXTURE:-}" "${BARE:-}" \
		"${ISSUES_JSON:-}" "${DRYRUN_OUT:-}" "${SPAWN_OUT:-}" \
		"${WATCH_OUT:-}" "${REVIEW_OUT:-}" "${WORKER_MOCK_LOG:-}" "${REVIEW_MOCK_LOG:-}" \
		"${EXHAUST_MOCK_LOG:-}" "${CONT_SPAWN_OUT:-}" "${CONT_OUT:-}"
	echo "  cleaned up temp fixture/bare/worktrees/logs (set KEEP=1 to retain)"
}

start_mock() {
	local scenario="$1"
	local logfile="$2"
	local portvar="$3"
	local env_extra=()
	if [ "$scenario" = "success" ]; then
		env_extra=(MOCK_FIXTURE_ROOT="$FIXTURE")
	fi
	(
		cd "$ROOT" &&
			env PORT=0 MOCK_SCENARIO="$scenario" "${env_extra[@]}" \
				node scripts/e2e/mock-openrouter.mjs
	) >"$logfile" 2>&1 &
	local pid=$!
	MOCK_PIDS="$MOCK_PIDS $pid"

	local port=""
	for _ in $(seq 1 100); do
		port="$(sed -n 's/.*listening on http:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' "$logfile" | head -n 1)"
		[ -n "$port" ] && break
		if ! kill -0 "$pid" 2>/dev/null; then
			echo "  mock ($scenario) exited before listening; log:" >&2
			cat "$logfile" >&2
			exit 1
		fi
		sleep 0.1
	done
	if [ -z "$port" ]; then
		echo "  mock ($scenario) did not become ready; log:" >&2
		cat "$logfile" >&2
		exit 1
	fi
	printf -v "$portvar" '%s' "$port"
	echo "  mock ($scenario) on 127.0.0.1:$port (pid $pid)"
}

# ── 1. Fixture repo + bare origin (the spawner branches off origin/master) ──
echo "== [1/10] fixture repo + origin =="
FIXTURE="$(bash "$ROOT/scripts/e2e-fixture/setup.sh")"
if [ -z "$FIXTURE" ] || [ ! -d "$FIXTURE/.git" ]; then
	echo "  fixture setup failed; aborting" >&2
	exit 1
fi
BARE="$(mktemp -d /tmp/headlesscode-e2e-bare-XXXXXX)"
git -C "$FIXTURE" branch -M master
git init --bare -q "$BARE"
git -C "$FIXTURE" remote add origin "$BARE"
git -C "$FIXTURE" -c user.name="E2E" -c user.email="e2e@headlesscode.invalid" -c commit.gpgsign=false \
	push -q -u origin master
echo "  fixture: $FIXTURE (origin -> $BARE, master pushed)"

# ── 2. Task files (the spawner copies these into each worktree) ─────────────
echo "== [2/10] task files =="
mkdir -p "$FIXTURE/plans/parallel-tasks"
cat > "$FIXTURE/plans/parallel-tasks/w1-issue1.md" <<'EOF'
## Your assignment

Fix the bug in src/greet.js: greet() must return "Hello, " + name (issue #1).

## Workflow

1. Read src/greet.js.
2. Patch it with write_to_file.
3. Verify with `node src/greet.test.js`.
4. Report via attempt_completion.
EOF
cat > "$FIXTURE/plans/parallel-tasks/w2-issue2-3.md" <<'EOF'
## Your assignment

Fix the bug in src/greet.js: greet() must return "Hello, " + name (issues #2 and #3).

## Workflow

1. Read src/greet.js.
2. Patch it with write_to_file.
3. Verify with `node src/greet.test.js`.
4. Report via attempt_completion.
EOF
echo "  wrote 2 task files under $FIXTURE/plans/parallel-tasks"

# ── 3. Mock OpenRouter servers (worker + reviewer, separate ports) ──────────
echo "== [3/10] mock OpenRouter servers =="
WORKER_MOCK_LOG="$(mktemp /tmp/headlesscode-e2e-phase2-worker-mock-XXXXXX.log)"
REVIEW_MOCK_LOG="$(mktemp /tmp/headlesscode-e2e-phase2-review-mock-XXXXXX.log)"
start_mock success "$WORKER_MOCK_LOG" WORKER_PORT
start_mock review-clean "$REVIEW_MOCK_LOG" REVIEW_PORT
sleep 0.2

# ── 4. orchestrate --dry-run: split plan + spawn commands ───────────────────
echo "== [4/10] orchestrate --dry-run =="
ISSUES_JSON="$(mktemp /tmp/headlesscode-e2e-phase2-issues-XXXXXX.json)"
cat > "$ISSUES_JSON" <<'EOF'
[
  { "number": 1, "title": "Add auth token validation to the request handler", "body": "hot path: auth + request handling" },
  { "number": 2, "title": "Split utils.py into focused modules", "body": "" },
  { "number": 3, "title": "Decompose models.py into focused files", "body": "" }
]
EOF
DRYRUN_OUT="$(mktemp /tmp/headlesscode-e2e-phase2-dryrun-XXXXXX.out)"
(
	cd "$ROOT" &&
		npx tsx src/cli.ts orchestrate --repo "$FIXTURE" --issues-json "$ISSUES_JSON" --dry-run
) >"$DRYRUN_OUT" 2>&1
DRYRUN_EXIT=$?
echo "  dry-run exit: $DRYRUN_EXIT"
if [ "$DRYRUN_EXIT" -eq 0 ] &&
	grep -q "w1:0:plans/parallel-tasks/w1-issue1.md" "$DRYRUN_OUT" &&
	grep -q "w2:1:plans/parallel-tasks/w2-issue2-3.md" "$DRYRUN_OUT"; then
	pass "dry-run prints split plan + spawn command (w1:0 + w2:1, airunner conventions)"
else
	fail "dry-run should print spawn command with w1:0:...w1-issue1.md and w2:1:...w2-issue2-3.md (exit $DRYRUN_EXIT)"
	tail -n 20 "$DRYRUN_OUT" >&2
fi

# ── 5. Real spawn (2 specs, real workers against the mock) ──────────────────
echo "== [5/10] spawn-parallel-worktrees.sh (2 specs) =="
SPAWN_OUT="$(mktemp /tmp/headlesscode-e2e-phase2-spawn-XXXXXX.out)"
(
	cd "$ROOT" &&
		TARGET_REPO="$FIXTURE" \
		HEADLESSCODE_OPENROUTER_API_KEY="test-key" \
		OPENROUTER_BASE_URL="http://127.0.0.1:$WORKER_PORT" \
		HEADLESSCODE_ROOT="$ROOT" \
		bash scripts/spawn-parallel-worktrees.sh \
			w1:0:plans/parallel-tasks/w1-issue1.md \
			w2:1:plans/parallel-tasks/w2-issue2-3.md
) >"$SPAWN_OUT" 2>&1
SPAWN_EXIT=$?
echo "  spawn exit: $SPAWN_EXIT"
WORKTREE_NAMES="w1 w2"
if [ "$SPAWN_EXIT" -eq 0 ] &&
	[ -d "$FIXTURE/.worktrees/w1" ] && [ -d "$FIXTURE/.worktrees/w2" ]; then
	pass "spawn created 2 worktrees"
else
	fail "spawn failed or worktrees missing (exit $SPAWN_EXIT)"
	tail -n 25 "$SPAWN_OUT" >&2
fi
if [ -f "$FIXTURE/.worktrees/.orchestrator-state.json" ] &&
	grep -q '"name": "w1"' "$FIXTURE/.worktrees/.orchestrator-state.json" &&
	grep -q '"name": "w2"' "$FIXTURE/.worktrees/.orchestrator-state.json"; then
	pass "state file has 2 groups (w1 + w2)"
else
	fail "state file missing or without both groups"
	[ -f "$FIXTURE/.worktrees/.orchestrator-state.json" ] && cat "$FIXTURE/.worktrees/.orchestrator-state.json" >&2 || true
fi
if [ -f "$FIXTURE/.worktrees/w1/.env" ] &&
	grep -q "COMPOSE_PROJECT_NAME=airunner-w1" "$FIXTURE/.worktrees/w1/.env" &&
	grep -q "POSTGRES_PORT=5433" "$FIXTURE/.worktrees/w1/.env" &&
	grep -q "POSTGRES_PORT=5434" "$FIXTURE/.worktrees/w2/.env" &&
	grep -q "AIRUNNER_HTTP_PORT=8090" "$FIXTURE/.worktrees/w1/.env" &&
	grep -q "AIRUNNER_HTTP_PORT=8100" "$FIXTURE/.worktrees/w2/.env" &&
	grep -q "VITE_PORT=5174" "$FIXTURE/.worktrees/w1/.env" &&
	grep -q "VITE_PORT=5175" "$FIXTURE/.worktrees/w2/.env"; then
	pass "per-worktree env isolation math (5433/8090/5174 + offset)"
else
	fail "per-worktree .env isolation overrides missing/wrong"
fi
if [ -f "$FIXTURE/.worktrees/w1/ORCHESTRATOR_TASK.md" ] &&
	grep -q "greet.js" "$FIXTURE/.worktrees/w1/ORCHESTRATOR_TASK.md"; then
	pass "ORCHESTRATOR_TASK.md copied into each worktree"
else
	fail "ORCHESTRATOR_TASK.md copy missing"
fi

# ── 6. Wait for completion markers (.harness.done) ──────────────────────────
echo "== [6/10] waiting for workers (.harness.done markers) =="
ALL_DONE=0
for _ in $(seq 1 180); do
	if [ -d "$FIXTURE/.worktrees/w1/.harness.done" ] && [ -d "$FIXTURE/.worktrees/w2/.harness.done" ]; then
		ALL_DONE=1
		break
	fi
	sleep 1
done
if [ "$ALL_DONE" -eq 1 ]; then
	pass "both workers completed (.harness.done markers present)"
else
	fail "workers did not complete within 180s; w1 log tail:"
	tail -n 20 "$FIXTURE/.worktrees/w1/harness.log" 2>/dev/null >&2 || true
	echo "  w2 log tail:" >&2
	tail -n 20 "$FIXTURE/.worktrees/w2/harness.log" 2>/dev/null >&2 || true
fi

W1_EXIT="$(cat "$FIXTURE/.worktrees/w1/.harness.exit" 2>/dev/null || echo '')"
W2_EXIT="$(cat "$FIXTURE/.worktrees/w2/.harness.exit" 2>/dev/null || echo '')"
if [ "$W1_EXIT" = "0" ] && [ "$W2_EXIT" = "0" ]; then
	pass "exit codes written and 0 (w1=$W1_EXIT, w2=$W2_EXIT)"
else
	fail "expected .harness.exit 0 for both (w1=$W1_EXIT, w2=$W2_EXIT)"
fi
if [ -s "$FIXTURE/.worktrees/w1/harness.log" ] && [ -s "$FIXTURE/.worktrees/w2/harness.log" ]; then
	pass "harness.log exists and is non-empty per worktree"
else
	fail "harness.log missing/empty for one or both worktrees"
fi

# Run the REAL watcher once: it must pick up the .harness.done markers and
# transition both groups to done in the state file (Phase 2 completion path).
echo "  running watchGroups (watch-invoke.ts)..."
WATCH_OUT="$(mktemp /tmp/headlesscode-e2e-phase2-watch-XXXXXX.out)"
(
	cd "$ROOT" && npx tsx scripts/e2e-phase2/watch-invoke.ts "$FIXTURE" 200
) >"$WATCH_OUT" 2>&1
WATCH_EXIT=$?
if [ "$WATCH_EXIT" -eq 0 ] && grep -q "ALL_TERMINAL=true" "$WATCH_OUT"; then
	pass "watcher converged: all groups terminal (exit $WATCH_EXIT)"
else
	fail "watcher did not converge (exit $WATCH_EXIT)"
	cat "$WATCH_OUT" >&2
fi
if grep -q "GROUP w1 status=done exit_code=0" "$WATCH_OUT" &&
	grep -q "GROUP w2 status=done exit_code=0" "$WATCH_OUT"; then
	pass "watcher recorded done + exit 0 for both groups in state"
else
	fail "expected both groups done with exit_code 0 in watcher output"
	cat "$WATCH_OUT" >&2
fi
if grep -q '"status": "done"' "$FIXTURE/.worktrees/.orchestrator-state.json"; then
	pass "state file records done status"
else
	fail "state file does not record done status after watchGroups"
	cat "$FIXTURE/.worktrees/.orchestrator-state.json" >&2
fi
if grep -q 'return "Hello, " + name' "$FIXTURE/.worktrees/w1/src/greet.js" &&
	grep -q 'return "Hello, " + name' "$FIXTURE/.worktrees/w2/src/greet.js"; then
	pass "both workers really fixed the fixture bug (mock-derived fix landed)"
else
	fail "expected the mock-derived fix in both worktrees"
fi

# ── 7. Mock request-log assertions (workers) ─────────────────────────────────
echo "== [7/10] worker mock request log =="
WORKER_REQ_COUNT="$(grep -c '\[mock\] request #' "$WORKER_MOCK_LOG" || true)"
echo "  worker mock requests: $WORKER_REQ_COUNT"
if [ "$WORKER_REQ_COUNT" -ge 6 ]; then
	pass "worker mock saw >= 6 requests (2 workers x 3-step scenario)"
else
	fail "worker mock saw only $WORKER_REQ_COUNT requests (expected >= 6)"
fi

# ── 8. Review invocation (second harness run, read-only) ────────────────────
echo "== [8/10] review invocation (mock scenario, read-only) =="
REVIEW_OUT="$(mktemp /tmp/headlesscode-e2e-phase2-review-XXXXXX.out)"
(
	cd "$ROOT" &&
		OPENROUTER_BASE_URL="http://127.0.0.1:$REVIEW_PORT" \
		HEADLESSCODE_OPENROUTER_API_KEY="test-key" \
		npx tsx scripts/e2e-phase2/review-invoke.ts --workspace "$FIXTURE/.worktrees/w1"
) >"$REVIEW_OUT" 2>&1
REVIEW_EXIT=$?
echo "  review exit: $REVIEW_EXIT"
if grep -q "REVIEW_VERDICT=clean" "$REVIEW_OUT"; then
	pass "review produced a verdict (REVIEW_VERDICT=clean)"
else
	fail "expected REVIEW_VERDICT=clean in review output (exit $REVIEW_EXIT)"
	tail -n 15 "$REVIEW_OUT" >&2
fi
# The reviewer must never receive write tools (read-only executor discipline).
FIRST_REVIEW_REQ="$(grep '\[mock\] request #1' "$REVIEW_MOCK_LOG" | head -n 1)"
if printf '%s' "$FIRST_REVIEW_REQ" | grep -q "tools=" &&
	! printf '%s' "$FIRST_REVIEW_REQ" | grep -q "write_to_file" &&
	printf '%s' "$FIRST_REVIEW_REQ" | grep -q "read_file"; then
	pass "review session exposed only read-only tools (no write_to_file)"
else
	fail "review request tools include write_to_file or are missing read_file: $FIRST_REVIEW_REQ"
fi
if grep -q "REVIEW_VERDICT=" "$REVIEW_OUT" && grep -q "REVIEW_FINDINGS=0" "$REVIEW_OUT"; then
	pass "clean review parsed with 0 findings"
else
	fail "clean review should parse to 0 findings"
fi

# ── 9. Iteration-exhaustion auto-continue (issue #2 Part 2) ─────────────────
# The mock "exhaustion" scenario makes a worker NEVER terminate, so with a tiny
# --max-iterations each session aborts with the exact "Max iterations" error.
# The continuation watcher (continuation-invoke.ts, wiring the same
# handleIterationExhaustion logic orchestrateMain uses) must re-spawn the
# worker on the SAME worktree twice (max-continuations 2) and then mark the
# group needs-human.
echo "== [9/10] iteration-exhaustion auto-continue (mock exhaustion scenario) =="
EXHAUST_MOCK_LOG="$(mktemp /tmp/headlesscode-e2e-phase2-exhaust-mock-XXXXXX.log)"
start_mock exhaustion "$EXHAUST_MOCK_LOG" EXHAUST_PORT
cat > "$FIXTURE/plans/parallel-tasks/w3-issue29.md" <<'EOF'
## Your assignment

Fix the bug in src/greet.js: greet() must return "Hello, " + name (issue #29).

## Workflow

1. Read src/greet.js.
2. Patch it with write_to_file.
3. Verify with `node src/greet.test.js`.
4. Report via attempt_completion.
EOF
CONT_SPAWN_OUT="$(mktemp /tmp/headlesscode-e2e-phase2-cont-spawn-XXXXXX.out)"
(
	cd "$ROOT" &&
		TARGET_REPO="$FIXTURE" \
		HEADLESSCODE_OPENROUTER_API_KEY="test-key" \
		OPENROUTER_BASE_URL="http://127.0.0.1:$EXHAUST_PORT" \
		HEADLESSCODE_ROOT="$ROOT" \
		HEADLESSCODE_MAX_ITERATIONS=3 \
		bash scripts/spawn-parallel-worktrees.sh w3:2:plans/parallel-tasks/w3-issue29.md
) >"$CONT_SPAWN_OUT" 2>&1
CONT_SPAWN_EXIT=$?
if [ "$CONT_SPAWN_EXIT" -eq 0 ] && [ -d "$FIXTURE/.worktrees/w3" ]; then
	pass "continuation fixture: worktree w3 created (HEADLESSCODE_MAX_ITERATIONS=3)"
else
	fail "continuation fixture: w3 spawn failed (exit $CONT_SPAWN_EXIT)"
	tail -n 15 "$CONT_SPAWN_OUT" >&2
fi
WORKTREE_NAMES="$WORKTREE_NAMES w3"

# Wait for the FIRST exhaustion (exit 1 + the exact Max-iterations error).
W3_EXHAUSTED=0
for _ in $(seq 1 120); do
	if [ -f "$FIXTURE/.worktrees/w3/.harness.exit" ]; then
		W3_EXHAUSTED=1
		break
	fi
	sleep 1
done
W3_EXIT="$(cat "$FIXTURE/.worktrees/w3/.harness.exit" 2>/dev/null || echo '')"
if [ "$W3_EXHAUSTED" -eq 1 ] && [ "$W3_EXIT" = "1" ] &&
	grep -q "Max iterations (3) reached without task completion" "$FIXTURE/.worktrees/w3/harness.log"; then
	pass "exhaustion worker exited 1 with the exact Max-iterations error in harness.log"
else
	fail "expected w3 worker to hit --max-iterations 3 (exit 1 + error in harness.log); got exit $W3_EXIT"
	tail -n 8 "$FIXTURE/.worktrees/w3/harness.log" 2>/dev/null >&2 || true
fi

# Run the continuation watcher (max-continuations 2 -> initial + 2 re-spawns -> needs-human).
CONT_OUT="$(mktemp /tmp/headlesscode-e2e-phase2-cont-XXXXXX.out)"
(
	cd "$ROOT" &&
		OPENROUTER_BASE_URL="http://127.0.0.1:$EXHAUST_PORT" \
		HEADLESSCODE_OPENROUTER_API_KEY="test-key" \
		HEADLESSCODE_ROOT="$ROOT" \
		npx tsx scripts/e2e-phase2/continuation-invoke.ts "$FIXTURE" 3 2
) >"$CONT_OUT" 2>&1
CONT_EXIT=$?
if grep -q "GROUP w3 status=needs-human" "$CONT_OUT" && grep -q "continuation_count=2" "$CONT_OUT"; then
	pass "group w3 reached needs-human after 2 continuations (count=2, terminal)"
else
	fail "expected w3 needs-human with continuation_count=2 (exit $CONT_EXIT)"
	tail -n 25 "$CONT_OUT" >&2
fi
if [ -f "$FIXTURE/plans/parallel-tasks/w3-continue1.md" ] && [ -f "$FIXTURE/plans/parallel-tasks/w3-continue2.md" ]; then
	pass "continuation task files written (w3-continue1.md + w3-continue2.md)"
else
	fail "expected w3-continue1.md and w3-continue2.md under $FIXTURE/plans/parallel-tasks"
fi
if [ -d "$FIXTURE/.worktrees/w3" ]; then
	pass "the SAME worktree was re-used across continuations (still one w3)"
else
	fail "w3 worktree missing after continuations"
fi

# ── 10. Summary + cleanup ────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo ""
echo "──────────────────────────────────────────────────────────────"
echo "  fixture:        $FIXTURE"
echo "  worker mock:    $WORKER_PORT ($WORKER_REQ_COUNT requests)"
echo "  review mock:    $REVIEW_PORT"
echo "  results:        PASS $PASS / $TOTAL   FAIL $FAIL / $TOTAL"
if [ "$FAIL" -eq 0 ]; then
	echo "  RESULT: PASS"
else
	echo "  RESULT: FAIL"
fi
echo "  spawn output:   $SPAWN_OUT"
echo "  dry-run output: $DRYRUN_OUT"
echo "  review output:  $REVIEW_OUT"
echo "──────────────────────────────────────────────────────────────"
cleanup

[ "$FAIL" -eq 0 ]
