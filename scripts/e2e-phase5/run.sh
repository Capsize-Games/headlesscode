#!/usr/bin/env bash
#
# run.sh — headlesscode Phase 5 end-to-end integration test (GitHub issue
# watcher). No real GitHub, no real API key, no real LLM, no real spawn of
# workers.
#
# What is exercised (the REAL watcher code path end-to-end):
#   1. `watch --dry-run`: listIssues against the fake GitHub server -> split
#      plan per issue printed, NO spawn, NO state file written.
#   2. `watch --run-once` with 1 new labeled issue: detected -> task file
#      written -> spawner invoked (via a STUBBED spawner script — the e2e
#      asserts state transitions + spawn invocation, not real git worktrees)
#      -> watcher state gains a "done" entry with the splitIssues groups.
#   3. Second `watch --run-once` on the same label: idempotent — NO duplicate
#      spawn (spawn-invoked marker count unchanged).
#   4. Label storm: 3 new issues with --max-per-sweep 1 -> one spawned, two
#      left "pending"; successive sweeps pick the pending ones up one at a
#      time until all are done.
#   5. Missing GH_TOKEN -> clear error, exit 2.
#
# What is stubbed (documented deviation, matching the spec's lighter path):
#   - scripts/e2e-phase5/mock-github.mjs — a fake GitHub REST server
#     (scripts/e2e/mock-openrouter.mjs pattern) serving scripted issues.
#   - The spawner script: the watcher normally calls the real
#     scripts/spawn-parallel-worktrees.sh (which creates git worktrees and
#     launches real harness workers via run-worker.sh). Here
#     HEADLESSCODE_SPAWN_SCRIPT points the watcher at a stub that creates
#     .worktrees/<name>/ dirs + appends a .spawn-invoked marker. The stub's
#     invocation is what we assert; the real spawner is covered by the
#     Phase 2 e2e.
#
# Usage: scripts/e2e-phase5/run.sh
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
		"${ISSUES1:-}" "${ISSUES2:-}" \
		"${MOCK1_LOG:-}" "${MOCK2_LOG:-}" \
		"${DRYRUN_OUT:-}" "${RUN1_OUT:-}" "${RUN2_OUT:-}" \
		"${STORM1_OUT:-}" "${STORM2_OUT:-}" "${STORM3_OUT:-}" \
		"${NOTOKEN_OUT:-}" "${SPAWN_STUB:-}"
	echo "  cleaned up temp fixture/logs (set KEEP=1 to retain)"
}

start_mock() {
	local issues_file="$1"
	local logfile="$2"
	local portvar="$3"
	(
		cd "$ROOT" &&
			env PORT=0 MOCK_ISSUES_FILE="$issues_file" \
				node scripts/e2e-phase5/mock-github.mjs
	) >"$logfile" 2>&1 &
	local pid=$!
	MOCK_PIDS="$MOCK_PIDS $pid"

	local port=""
	for _ in $(seq 1 100); do
		port="$(sed -n 's/.*listening on http:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' "$logfile" | head -n 1)"
		[ -n "$port" ] && break
		if ! kill -0 "$pid" 2>/dev/null; then
			echo "  mock (issues=$issues_file) exited before listening; log:" >&2
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
	echo "  mock (issues=$(basename "$issues_file")) on 127.0.0.1:$port (pid $pid)"
}

kill_mock() {
	for p in $MOCK_PIDS; do
		kill "$p" 2>/dev/null || true
		wait "$p" 2>/dev/null || true
	done
	MOCK_PIDS=""
}

# ── 1. Fixture repo + stub spawner ──────────────────────────────────────────
echo "== [1/9] fixture repo + stub spawner =="
FIXTURE="$(bash "$ROOT/scripts/e2e-fixture/setup.sh")"
if [ -z "$FIXTURE" ] || [ ! -d "$FIXTURE/.git" ]; then
	echo "  fixture setup failed; aborting" >&2
	exit 1
fi

# Stub spawner: mimics enough of scripts/spawn-parallel-worktrees.sh for the
# e2e — creates .worktrees/<name>/ and appends a spawn-invoked marker — but
# never creates real git worktrees or launches workers. The watcher invokes it
# exactly as it would the real script (bash -c, TARGET_REPO env set).
SPAWN_STUB="$(mktemp /tmp/headlesscode-e2e5-spawn-XXXXXX.sh)"
cat > "$SPAWN_STUB" <<'EOF'
#!/usr/bin/env bash
# STUB spawner for the Phase 5 e2e — see scripts/e2e-phase5/run.sh.
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
echo "  fixture: $FIXTURE"
echo "  stub spawner: $SPAWN_STUB"

# ── 2. Scripted issue sets ───────────────────────────────────────────────────
echo "== [2/9] scripted issues =="
ISSUES1="$(mktemp /tmp/headlesscode-e2e5-issues1-XXXXXX.json)"
cat > "$ISSUES1" <<'EOF'
[
  {
    "number": 101,
    "title": "Fix the greet bug",
    "body": "greet() must return 'Hello, ' + name",
    "labels": [{ "name": "needs-agent" }],
    "updated_at": "2026-08-01T00:00:00Z",
    "html_url": "https://github.com/acme/widget/issues/101"
  }
]
EOF
ISSUES2="$(mktemp /tmp/headlesscode-e2e5-issues2-XXXXXX.json)"
cat > "$ISSUES2" <<'EOF'
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
echo "  issues1 (1 issue): $ISSUES1"
echo "  issues2 (3-issue storm): $ISSUES2"

# ── 3. Mock GitHub server (issues1) ─────────────────────────────────────────
echo "== [3/9] mock GitHub server (issues1) =="
MOCK1_LOG="$(mktemp /tmp/headlesscode-e2e5-mock1-XXXXXX.log)"
start_mock "$ISSUES1" "$MOCK1_LOG" MOCK1_PORT
sleep 0.2

# ── 4. Dry-run: report plan, no spawn, no state ─────────────────────────────
echo "== [4/9] watch --dry-run (no spawn, no state) =="
DRYRUN_OUT="$(mktemp /tmp/headlesscode-e2e5-dryrun-XXXXXX.out)"
(
	cd "$ROOT" &&
		GH_TOKEN="test" \
		GITHUB_API_BASE_URL="http://127.0.0.1:$MOCK1_PORT" \
		HEADLESSCODE_SPAWN_SCRIPT="$SPAWN_STUB" \
		npx tsx src/cli.ts watch --owner acme --repo "$FIXTURE" --label needs-agent \
			--dry-run --run-once
) >"$DRYRUN_OUT" 2>&1
DRYRUN_EXIT=$?
echo "  dry-run exit: $DRYRUN_EXIT"
if [ "$DRYRUN_EXIT" -eq 0 ] &&
	grep -q "issue #101" "$DRYRUN_OUT" &&
	grep -q "w1-issue101.md" "$DRYRUN_OUT"; then
	pass "dry-run prints the split plan (issue #101 -> w1-issue101.md)"
else
	fail "dry-run should report the spawn plan (exit $DRYRUN_EXIT)"
	tail -n 20 "$DRYRUN_OUT" >&2
fi
if [ ! -f "$FIXTURE/.worktrees/.watcher-state.json" ]; then
	pass "dry-run wrote no watcher state file"
else
	fail "dry-run must not write the state file"
fi
if [ ! -f "$FIXTURE/.worktrees/.spawn-invoked" ]; then
	pass "dry-run never invoked the spawner"
else
	fail "dry-run must not spawn"
fi

# ── 5. Real run 1: detect + spawn one issue ─────────────────────────────────
echo "== [5/9] watch --run-once (1 new issue) =="
RUN1_OUT="$(mktemp /tmp/headlesscode-e2e5-run1-XXXXXX.out)"
(
	cd "$ROOT" &&
		GH_TOKEN="test" \
		GITHUB_API_BASE_URL="http://127.0.0.1:$MOCK1_PORT" \
		HEADLESSCODE_SPAWN_SCRIPT="$SPAWN_STUB" \
		npx tsx src/cli.ts watch --owner acme --repo "$FIXTURE" --label needs-agent \
			--run-once --max-per-sweep 5
) >"$RUN1_OUT" 2>&1
RUN1_EXIT=$?
echo "  run1 exit: $RUN1_EXIT"
STATE_FILE="$FIXTURE/.worktrees/.watcher-state.json"
if [ "$RUN1_EXIT" -eq 0 ] && grep -q "1 spawned" "$RUN1_OUT"; then
	pass "run1 spawned 1 batch (exit $RUN1_EXIT)"
else
	fail "run1 should spawn 1 batch (exit $RUN1_EXIT)"
	tail -n 20 "$RUN1_OUT" >&2
fi
if [ -f "$STATE_FILE" ] && grep -q '"101"' "$STATE_FILE" && grep -q '"status": "done"' "$STATE_FILE"; then
	pass "watcher state records issue #101 as done"
else
	fail "state file missing a done entry for #101"
	[ -f "$STATE_FILE" ] && cat "$STATE_FILE" >&2 || true
fi
if grep -q '"groups"' "$STATE_FILE" && grep -q 'w1-issue101.md' "$STATE_FILE"; then
	pass "state entry carries the splitIssues groups (w1-issue101.md)"
else
	fail "state entry missing splitIssues groups"
fi
if [ -f "$FIXTURE/plans/parallel-tasks/w1-issue101.md" ]; then
	pass "task file written (reused orchestrator builder)"
else
	fail "task file plans/parallel-tasks/w1-issue101.md missing"
fi
if [ -d "$FIXTURE/.worktrees/w1" ] && [ "$(wc -l < "$FIXTURE/.worktrees/.spawn-invoked")" -eq 1 ]; then
	pass "spawner invoked once, worktree dir created"
else
	fail "expected spawner invoked exactly once with .worktrees/w1"
	[ -f "$FIXTURE/.worktrees/.spawn-invoked" ] && cat "$FIXTURE/.worktrees/.spawn-invoked" >&2 || true
fi
if grep -q 'labels=needs-agent' "$MOCK1_LOG"; then
	pass "watcher asked the API for the target label (labels=needs-agent)"
else
	fail "mock log missing the labels=needs-agent query"
	cat "$MOCK1_LOG" >&2
fi

# ── 6. Run 2: idempotent (no duplicate spawn) ───────────────────────────────
echo "== [6/9] watch --run-once again (idempotent) =="
RUN2_OUT="$(mktemp /tmp/headlesscode-e2e5-run2-XXXXXX.out)"
(
	cd "$ROOT" &&
		GH_TOKEN="test" \
		GITHUB_API_BASE_URL="http://127.0.0.1:$MOCK1_PORT" \
		HEADLESSCODE_SPAWN_SCRIPT="$SPAWN_STUB" \
		npx tsx src/cli.ts watch --owner acme --repo "$FIXTURE" --label needs-agent \
			--run-once --max-per-sweep 5
) >"$RUN2_OUT" 2>&1
RUN2_EXIT=$?
echo "  run2 exit: $RUN2_EXIT"
SPAWN_LINES_AFTER_RUN2="$(wc -l < "$FIXTURE/.worktrees/.spawn-invoked" 2>/dev/null || echo 0)"
if [ "$RUN2_EXIT" -eq 0 ] && grep -q "1 skipped" "$RUN2_OUT"; then
	pass "run2 skipped the already-processed issue"
else
	fail "run2 should skip the processed issue (exit $RUN2_EXIT)"
	tail -n 20 "$RUN2_OUT" >&2
fi
if [ "$SPAWN_LINES_AFTER_RUN2" -eq 1 ]; then
	pass "no duplicate spawn on the second sweep"
else
	fail "second run spawned again (spawn-invoked has $SPAWN_LINES_AFTER_RUN2 lines)"
fi

# ── 7. Label storm: 3 issues, max-per-sweep 1 ───────────────────────────────
echo "== [7/9] label storm (3 issues, max-per-sweep 1) =="
kill_mock
MOCK2_LOG="$(mktemp /tmp/headlesscode-e2e5-mock2-XXXXXX.log)"
start_mock "$ISSUES2" "$MOCK2_LOG" MOCK2_PORT
sleep 0.2

STORM1_OUT="$(mktemp /tmp/headlesscode-e2e5-storm1-XXXXXX.out)"
(
	cd "$ROOT" &&
		GH_TOKEN="test" \
		GITHUB_API_BASE_URL="http://127.0.0.1:$MOCK2_PORT" \
		HEADLESSCODE_SPAWN_SCRIPT="$SPAWN_STUB" \
		npx tsx src/cli.ts watch --owner acme --repo "$FIXTURE" --label needs-agent \
			--run-once --max-per-sweep 1
) >"$STORM1_OUT" 2>&1
STORM1_EXIT=$?
echo "  storm run1 exit: $STORM1_EXIT"
SPAWN_LINES1="$(wc -l < "$FIXTURE/.worktrees/.spawn-invoked" 2>/dev/null || echo 0)"
if [ "$STORM1_EXIT" -eq 0 ] && [ "$SPAWN_LINES1" -eq 2 ]; then
	pass "storm run1 spawned exactly 1 new batch (cap respected)"
else
	fail "storm run1 should spawn 1 (marker=$SPAWN_LINES1, exit $STORM1_EXIT)"
	tail -n 20 "$STORM1_OUT" >&2
fi
if grep -q '"201"' "$STATE_FILE" && grep -q '"status": "done"' "$STATE_FILE" &&
	grep -q '"202"' "$STATE_FILE" && grep -q '"status": "pending"' "$STATE_FILE" &&
	grep -q '"203"' "$STATE_FILE" && grep -q '"status": "pending"' "$STATE_FILE"; then
	pass "state: #201 done, #202+#203 pending (deferred by the cap)"
else
	fail "storm run1 state shape wrong"
	cat "$STATE_FILE" >&2
fi

STORM2_OUT="$(mktemp /tmp/headlesscode-e2e5-storm2-XXXXXX.out)"
(
	cd "$ROOT" &&
		GH_TOKEN="test" \
		GITHUB_API_BASE_URL="http://127.0.0.1:$MOCK2_PORT" \
		HEADLESSCODE_SPAWN_SCRIPT="$SPAWN_STUB" \
		npx tsx src/cli.ts watch --owner acme --repo "$FIXTURE" --label needs-agent \
			--run-once --max-per-sweep 1
) >"$STORM2_OUT" 2>&1
STORM2_EXIT=$?
SPAWN_LINES2="$(wc -l < "$FIXTURE/.worktrees/.spawn-invoked" 2>/dev/null || echo 0)"
PENDING_AFTER_RUN2="$(grep -c '"status": "pending"' "$STATE_FILE" 2>/dev/null || true)"
if [ "$STORM2_EXIT" -eq 0 ] && [ "$SPAWN_LINES2" -eq 3 ] && [ "$PENDING_AFTER_RUN2" -eq 1 ]; then
	pass "storm run2 picked up one pending issue (#202 done, #203 still pending)"
else
	fail "storm run2 should spawn the next pending issue (marker=$SPAWN_LINES2, pending=$PENDING_AFTER_RUN2)"
	tail -n 20 "$STORM2_OUT" >&2
fi

STORM3_OUT="$(mktemp /tmp/headlesscode-e2e5-storm3-XXXXXX.out)"
(
	cd "$ROOT" &&
		GH_TOKEN="test" \
		GITHUB_API_BASE_URL="http://127.0.0.1:$MOCK2_PORT" \
		HEADLESSCODE_SPAWN_SCRIPT="$SPAWN_STUB" \
		npx tsx src/cli.ts watch --owner acme --repo "$FIXTURE" --label needs-agent \
			--run-once --max-per-sweep 5
) >"$STORM3_OUT" 2>&1
STORM3_EXIT=$?
SPAWN_LINES3="$(wc -l < "$FIXTURE/.worktrees/.spawn-invoked" 2>/dev/null || echo 0)"
if [ "$STORM3_EXIT" -eq 0 ] && [ "$SPAWN_LINES3" -eq 4 ]; then
	pass "storm run3 drained the last pending issue (#203 done)"
else
	fail "storm run3 should spawn the final pending issue (marker=$SPAWN_LINES3)"
	tail -n 20 "$STORM3_OUT" >&2
fi
if [ "$(grep -c '"status": "pending"' "$STATE_FILE" 2>/dev/null || true)" -eq 0 ]; then
	pass "no pending issues remain after the storm drained"
else
	fail "some issues still pending after 3 sweeps"
	cat "$STATE_FILE" >&2
fi

# ── 8. Missing token -> clear error ──────────────────────────────────────────
echo "== [8/9] missing GH_TOKEN =="
NOTOKEN_OUT="$(mktemp /tmp/headlesscode-e2e5-notoken-XXXXXX.out)"
(
	cd "$ROOT" &&
		env -u GH_TOKEN -u GITHUB_TOKEN \
			GITHUB_API_BASE_URL="http://127.0.0.1:$MOCK2_PORT" \
			npx tsx src/cli.ts watch --owner acme --repo "$FIXTURE" --label needs-agent --run-once
) >"$NOTOKEN_OUT" 2>&1
NOTOKEN_EXIT=$?
if [ "$NOTOKEN_EXIT" -eq 2 ] && grep -q "GH_TOKEN" "$NOTOKEN_OUT"; then
	pass "missing token -> clear error, exit 2"
else
	fail "missing token should error clearly (exit $NOTOKEN_EXIT)"
	tail -n 10 "$NOTOKEN_OUT" >&2
fi

# ── 9. Summary + cleanup ─────────────────────────────────────────────────────
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
