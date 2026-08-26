#!/usr/bin/env bash
#
# run.sh — headlesscode Phase 2 end-to-end integration test (orchestration
# layer). No API key, no network, no X server / xdotool / GUI.
#
# Exercises the REAL pieces of Phase 2 end-to-end:
#   1. `orchestrate --dry-run`: issues-json -> splitIssues (the orchestration
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
	# Stop any still-running workers' WHOLE process trees (issue #20) — killing
	# the wrapper PID alone would leave the real child running undetected.
	if [ -n "${FIXTURE:-}" ]; then
		for n in $WORKTREE_NAMES; do
			bash "$ROOT/scripts/stop-worker.sh" "$FIXTURE/.worktrees/$n" >/dev/null 2>&1 || true
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
		"${EXHAUST_MOCK_LOG:-}" "${CONT_SPAWN_OUT:-}" "${CONT_OUT:-}" \
		"${STOP_SPAWN_OUT:-}" "${STOP_OUT:-}" \
		"${PLAN_MOCK_LOG:-}" "${PLAN_SPAWN_OUT:-}"
	echo "  cleaned up temp fixture/bare/worktrees/logs (set KEEP=1 to retain)"
}

start_mock() {
	local scenario="$1"
	local logfile="$2"
	local portvar="$3"
	local env_extra=()
	if [ "$scenario" = "success" ] || [ "$scenario" = "plan-first" ]; then
		# plan-first: the code worker half of the scenario derives its fix
		# content from the fixture exactly like the success scenario.
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
	pass "dry-run prints split plan + spawn command (w1:0 + w2:1, orchestration conventions)"
else
	fail "dry-run should print spawn command with w1:0:...w1-issue1.md and w2:1:...w2-issue2-3.md (exit $DRYRUN_EXIT)"
	tail -n 20 "$DRYRUN_OUT" >&2
fi

# ── 5. Real spawn (2 specs, real workers against the mock) ──────────────────
echo "== [4.5/10] no-index guardrail: ALLOW_UNINDEXED unset => hard fail =="
GUARD_OUT="$(mktemp /tmp/headlesscode-e2e-phase2-guard-XXXXXX.out)"
(
	cd "$ROOT" &&
		TARGET_REPO="$FIXTURE" \
		HEADLESSCODE_ROOT="$ROOT" \
		bash scripts/spawn-parallel-worktrees.sh probe:9:plans/parallel-tasks/never-created.md
) >"$GUARD_OUT" 2>&1
GUARD_EXIT=$?
if [ "$GUARD_EXIT" -ne 0 ] &&
	grep -q "No codebase-search index found" "$GUARD_OUT" &&
	[ ! -d "$FIXTURE/.worktrees/probe" ]; then
	pass "spawner hard-fails on a missing index (exit $GUARD_EXIT, no worktree created)"
else
	fail "expected non-zero exit + 'No codebase-search index found' + no worktree; got exit $GUARD_EXIT"
	tail -n 10 "$GUARD_OUT" >&2
fi

echo "== [5/10] spawn-parallel-worktrees.sh (2 specs) =="
# Give the fixture a legacy workspace-relative mode-models.json (the P0.2
# config file): the spawner no longer seeds it into worktrees — workers
# resolve it from the CENTRAL project store (src/project-store.ts), keyed by
# the repo's git-common-dir so every worktree shares it. The assertion below
# verifies the real resolution path (migrateLegacyProjectData +
# resolveModelForMode) still lands the cheap `_condensation` model instead of
# silently running condensation on the full session model.
mkdir -p "$FIXTURE/.headlesscode"
cat > "$FIXTURE/.headlesscode/mode-models.json" <<'EOF'
{
  "_default": "deepseek/deepseek-v4-flash-0731",
  "code": "deepseek/deepseek-v4-flash-0731",
  "architect": "deepseek/architect-plan",
  "_condensation": "qwen/qwen3-8b"
}
EOF
SPAWN_OUT="$(mktemp /tmp/headlesscode-e2e-phase2-spawn-XXXXXX.out)"
(
	cd "$ROOT" &&
		TARGET_REPO="$FIXTURE" \
		HEADLESSCODE_OPENROUTER_API_KEY="test-key" \
		OPENROUTER_BASE_URL="http://127.0.0.1:$WORKER_PORT" \
		HEADLESSCODE_ROOT="$ROOT" \
		ALLOW_UNINDEXED=1 \
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
	grep -q "COMPOSE_PROJECT_NAME=headlesscode-w1" "$FIXTURE/.worktrees/w1/.env" &&
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
# mode-models.json now lives in the CENTRAL store (src/project-store.ts),
# keyed by the repo's git-common-dir — the spawner's per-worktree seeding is
# deliberately gone (see spawn-parallel-worktrees.sh). Assert the NEW
# contract: no seed file in the worktrees, and the worker's real resolution
# path still lands the cheap `_condensation` model. The migration is explicit
# here (migrateLegacyProjectData — the same function the auto path and
# `headlesscode migrate` call) because under a $HEADLESSCODE_DATA_DIR
# override the auto migration is skipped.
if [ -f "$FIXTURE/.worktrees/w1/.headlesscode/mode-models.json" ] ||
	[ -f "$FIXTURE/.worktrees/w2/.headlesscode/mode-models.json" ]; then
	fail "per-worktree mode-models.json seed file found — per-worktree seeding should be gone (central store)"
else
	pass "no per-worktree mode-models.json seeding (worktrees share the central store)"
fi
MM_RESOLVED="$(
	cd "$ROOT" &&
		npx tsx -e '
			import { migrateLegacyProjectData, resolveProjectDataDir, resolveProjectIdentity } from "./src/project-store.ts"
			import { resolveModelForMode } from "./src/config/mode-models.ts"
			const [ws] = process.argv.slice(1)
			const identity = resolveProjectIdentity(ws)
			migrateLegacyProjectData(ws, identity.keySource, resolveProjectDataDir(ws), { log: () => {} })
			const resolved = resolveModelForMode({ workspaceRoot: ws, mode: "code", extraKeys: ["_condensation"] })
			process.stdout.write(resolved ?? "<unset>")
		' "$FIXTURE/.worktrees/w1"
)"
if [ "$MM_RESOLVED" = "qwen/qwen3-8b" ]; then
	pass "worker resolves _condensation=qwen/qwen3-8b via the central store"
else
	fail "expected _condensation=qwen/qwen3-8b from the central store, got '$MM_RESOLVED'"
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
		ALLOW_UNINDEXED=1 \
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

# ── 9.5. Stop capability (issue #20): killing the wrapper PID must not leave ─
#        the actual work running — stop-worker.sh kills the WHOLE tree. ──────
# Requires setsid (Linux util-linux), which run-worker.sh uses to put each
# worker in its own process group.
echo "== [9.5/10] stop-worker.sh kills the whole process tree (issue #20) =="
cat > "$FIXTURE/plans/parallel-tasks/w4-issue20.md" <<'EOF'
## Your assignment

Fix the bug in src/greet.js: greet() must return "Hello, " + name (issue #20).

## Workflow

1. Read src/greet.js.
2. Patch it with write_to_file.
3. Verify with `node src/greet.test.js`.
4. Report via attempt_completion.
EOF
STOP_SPAWN_OUT="$(mktemp /tmp/headlesscode-e2e-phase2-stop-spawn-XXXXXX.out)"
(
	cd "$ROOT" &&
		TARGET_REPO="$FIXTURE" \
		HEADLESSCODE_OPENROUTER_API_KEY="test-key" \
		OPENROUTER_BASE_URL="http://127.0.0.1:$EXHAUST_PORT" \
		HEADLESSCODE_ROOT="$ROOT" \
		HEADLESSCODE_MAX_ITERATIONS=200 \
		ALLOW_UNINDEXED=1 \
		bash scripts/spawn-parallel-worktrees.sh w4:3:plans/parallel-tasks/w4-issue20.md
) >"$STOP_SPAWN_OUT" 2>&1
STOP_SPAWN_EXIT=$?
if [ "$STOP_SPAWN_EXIT" -eq 0 ] && [ -d "$FIXTURE/.worktrees/w4" ]; then
	pass "stop fixture: worktree w4 spawned against the exhaustion mock"
else
	fail "stop fixture: w4 spawn failed (exit $STOP_SPAWN_EXIT)"
	tail -n 15 "$STOP_SPAWN_OUT" >&2
fi
WORKTREE_NAMES="$WORKTREE_NAMES w4"

# Wait for the worker to be up with its process-group id recorded.
W4_UP=0
for _ in $(seq 1 30); do
	if [ -f "$FIXTURE/.worktrees/w4/.harness.pgid" ]; then
		W4_UP=1
		break
	fi
	sleep 1
done
W4_PGID="$(cat "$FIXTURE/.worktrees/w4/.harness.pgid" 2>/dev/null || true)"
if [ "$W4_UP" -eq 1 ] && [ -n "$W4_PGID" ]; then
	pass "stop fixture: worker up with .harness.pgid=$W4_PGID"
else
	fail "stop fixture: w4 never became ready (no .harness.pgid)"
	tail -n 10 "$FIXTURE/.worktrees/w4/harness.log" 2>/dev/null >&2 || true
fi

# The worker is a setsid group leader: its whole tree is one live group.
if [ -n "$W4_PGID" ] && kill -0 -- "-$W4_PGID" 2>/dev/null; then
	pass "stop fixture: process group -$W4_PGID is alive (whole tree in one group)"
else
	fail "stop fixture: expected a live process group -$W4_PGID"
fi

# Stop it: the WHOLE tree must die, and no completion marker may appear.
STOP_OUT="$(mktemp /tmp/headlesscode-e2e-phase2-stop-XXXXXX.out)"
(
	cd "$ROOT" && bash scripts/stop-worker.sh "$FIXTURE/.worktrees/w4"
) >"$STOP_OUT" 2>&1
STOP_EXIT=$?
if [ "$STOP_EXIT" -eq 0 ] && [ -n "$W4_PGID" ] && ! kill -0 -- "-$W4_PGID" 2>/dev/null; then
	pass "stop-worker.sh killed the whole process tree (exit 0, group -$W4_PGID gone)"
else
	fail "stop-worker.sh did not kill the tree (exit $STOP_EXIT)"
	cat "$STOP_OUT" >&2
fi
sleep 3
if [ ! -d "$FIXTURE/.worktrees/w4/.harness.done" ]; then
	pass "stop fixture: no .harness.done after stop (worker was really stopped)"
else
	fail "stop fixture: .harness.done appeared after stop — the worker finished anyway"
fi
if [ ! -f "$FIXTURE/.worktrees/w4/.harness.exit" ]; then
	pass "stop fixture: no .harness.exit after stop (wrapper was killed with the tree)"
else
	fail "stop fixture: .harness.exit present after stop — wrapper survived"
fi

# ── 9.6. Branch-name collision disambiguation (issue #15) ────────────────────
# A leftover branch with the intended name (local, or already on origin) used
# to make the worker's push fail mid-round; the worker then improvised a
# renamed push that left the local worktree branch under the old name, and
# nobody could find the real branch. The spawner must instead disambiguate at
# CREATION TIME (one name, local == pushed), name it loudly on stdout, and
# record the REAL name in group.branch in the orchestrator state.
echo "== [9.6/10] branch-name collision disambiguation (issue #15) =="
COLLIDE_DATE="$(date +%Y-%m-%d)"
# Local leftover: a branch named exactly as w5's intended branch.
git -C "$FIXTURE" branch "issues/w5-${COLLIDE_DATE}" master >/dev/null 2>&1 || true
# Remote leftover: push a branch named exactly as w6's intended branch.
git -C "$FIXTURE" push -q origin "master:refs/heads/issues/w6-${COLLIDE_DATE}" >/dev/null 2>&1 || true
COLLIDE_SPAWN_OUT="$(mktemp /tmp/headlesscode-e2e-phase2-collide-XXXXXX.out)"
(
	cd "$ROOT" &&
		TARGET_REPO="$FIXTURE" \
		HEADLESSCODE_OPENROUTER_API_KEY="test-key" \
		OPENROUTER_BASE_URL="http://127.0.0.1:$EXHAUST_PORT" \
		HEADLESSCODE_ROOT="$ROOT" \
		HEADLESSCODE_MAX_ITERATIONS=1 \
		ALLOW_UNINDEXED=1 \
		bash scripts/spawn-parallel-worktrees.sh w5:4: w6:5:
) >"$COLLIDE_SPAWN_OUT" 2>&1
COLLIDE_SPAWN_EXIT=$?
if [ "$COLLIDE_SPAWN_EXIT" -eq 0 ] && [ -d "$FIXTURE/.worktrees/w5" ] && [ -d "$FIXTURE/.worktrees/w6" ]; then
	pass "collision fixture: w5 + w6 spawned despite both intended branch names being taken"
else
	fail "collision fixture: spawn failed (exit $COLLIDE_SPAWN_EXIT)"
	tail -n 15 "$COLLIDE_SPAWN_OUT" >&2
fi
WORKTREE_NAMES="$WORKTREE_NAMES w5 w6"

# The worktree's checked-out branch must BE the disambiguated name (so the
# local branch == the branch that will be pushed — no mismatch to discover).
W5_BRANCH="$(git -C "$FIXTURE/.worktrees/w5" symbolic-ref --short HEAD 2>/dev/null || true)"
W6_BRANCH="$(git -C "$FIXTURE/.worktrees/w6" symbolic-ref --short HEAD 2>/dev/null || true)"
if [ "$W5_BRANCH" = "issues/w5-${COLLIDE_DATE}-2" ] && [ "$W6_BRANCH" = "issues/w6-${COLLIDE_DATE}-2" ]; then
	pass "collision fixture: worktrees on disambiguated branches ($W5_BRANCH, $W6_BRANCH)"
else
	fail "collision fixture: expected issues/w5-$COLLIDE_DATE-2 + issues/w6-$COLLIDE_DATE-2, got '$W5_BRANCH' + '$W6_BRANCH'"
fi

# The rename must be loud and structured in the spawn log, not prose buried
# in a worker's closing report.
if grep -q "using disambiguated branch 'issues/w5-${COLLIDE_DATE}-2'" "$COLLIDE_SPAWN_OUT" &&
	grep -q "using disambiguated branch 'issues/w6-${COLLIDE_DATE}-2'" "$COLLIDE_SPAWN_OUT"; then
	pass "collision fixture: spawn log names the disambiguated branches loudly"
else
	fail "collision fixture: expected loud disambiguation lines in spawn output"
	tail -n 15 "$COLLIDE_SPAWN_OUT" >&2
fi

# group.branch in the orchestrator state must be the REAL final name, not the
# originally-intended (colliding) one.
if grep -q "\"branch\": \"issues/w5-${COLLIDE_DATE}-2\"" "$FIXTURE/.worktrees/.orchestrator-state.json" &&
	grep -q "\"branch\": \"issues/w6-${COLLIDE_DATE}-2\"" "$FIXTURE/.worktrees/.orchestrator-state.json"; then
	pass "collision fixture: group.branch records the real disambiguated name for both groups"
else
	fail "collision fixture: state group.branch is not the disambiguated name"
	grep -o '"name": "w[56]".*' "$FIXTURE/.worktrees/.orchestrator-state.json" >&2 || true
fi

# The leftover branches must be untouched — nothing was force-deleted.
if [ -n "$(git -C "$FIXTURE" branch --list "issues/w5-${COLLIDE_DATE}")" ] &&
	git -C "$FIXTURE" ls-remote --exit-code origin "refs/heads/issues/w6-${COLLIDE_DATE}" >/dev/null 2>&1; then
	pass "collision fixture: leftover local + origin branches preserved"
else
	fail "collision fixture: a leftover branch was deleted/modified"
fi

# ── 9.7. Plan-first phase (issue #49) ────────────────────────────────────────
# An architect-mode planning session runs in the worktree BEFORE the code
# worker; its plan (PLAN.md) is appended into ORCHESTRATOR_TASK.md so the
# worker executes against it. The mock scenario "plan-first" serves BOTH
# sessions on one port, dispatching on the MODEL field: the fixture maps the
# "architect" mode to deepseek/architect-plan (plan script: explore -> write
# PLAN.md -> complete), while the code worker's model falls through to the
# standard success script. Assertions: the plan phase ran first, the plan
# landed in ORCHESTRATOR_TASK.md, the worker still completed + fixed the bug,
# and the state records plan_first.status=ok.
echo "== [9.7/10] plan-first (issue #49): architect plan session before the code worker =="
PLAN_MOCK_LOG="$(mktemp /tmp/headlesscode-e2e-phase2-plan-mock-XXXXXX.log)"
start_mock plan-first "$PLAN_MOCK_LOG" PLAN_PORT
cat > "$FIXTURE/plans/parallel-tasks/w7-issue7.md" <<'EOF'
## Your assignment

Fix the bug in src/greet.js: greet() must return "Hello, " + name (issue #7).

## Workflow

1. Read src/greet.js.
2. Patch it with write_to_file.
3. Verify with `node src/greet.test.js`.
4. Report via attempt_completion.
EOF
# The plan-first session's task file — what the orchestrator writes for a
# --plan-first round (buildPlanFirstTaskFileContent); the spawner copies it
# into the worktree as ORCHESTRATOR_PLAN.md and runs it BEFORE the worker.
cat > "$FIXTURE/plans/parallel-tasks/w7-plan.md" <<'EOF'
## Planning phase

Produce a compact implementation plan for ORCHESTRATOR_TASK.md (issue #7) and
write it to PLAN.md at the workspace root. DO NOT implement anything.
EOF
PLAN_SPAWN_OUT="$(mktemp /tmp/headlesscode-e2e-phase2-plan-spawn-XXXXXX.out)"
(
	cd "$ROOT" &&
		TARGET_REPO="$FIXTURE" \
		HEADLESSCODE_OPENROUTER_API_KEY="test-key" \
		OPENROUTER_BASE_URL="http://127.0.0.1:$PLAN_PORT" \
		HEADLESSCODE_ROOT="$ROOT" \
		ALLOW_UNINDEXED=1 \
		PLAN_FIRST=1 \
		bash scripts/spawn-parallel-worktrees.sh w7:6:plans/parallel-tasks/w7-issue7.md
) >"$PLAN_SPAWN_OUT" 2>&1
PLAN_SPAWN_EXIT=$?
if [ "$PLAN_SPAWN_EXIT" -eq 0 ] && [ -d "$FIXTURE/.worktrees/w7" ]; then
	pass "plan-first: worktree w7 spawned with PLAN_FIRST=1"
else
	fail "plan-first: w7 spawn failed (exit $PLAN_SPAWN_EXIT)"
	tail -n 25 "$PLAN_SPAWN_OUT" >&2
fi
WORKTREE_NAMES="$WORKTREE_NAMES w7"

# The plan session ran BEFORE the worker: PLAN.md exists, and the plan was
# appended into ORCHESTRATOR_TASK.md under the Implementation-plan section.
if grep -q "Plan-first phase for 'w7' (mode architect" "$PLAN_SPAWN_OUT" &&
	grep -q "appended to ORCHESTRATOR_TASK.md" "$PLAN_SPAWN_OUT"; then
	pass "plan-first: spawner ran the architect planning session and appended the plan"
else
	fail "plan-first: spawn output missing the plan-first phase lines"
	tail -n 25 "$PLAN_SPAWN_OUT" >&2
fi
if [ -s "$FIXTURE/.worktrees/w7/PLAN.md" ] &&
	grep -q "mock plan-first" "$FIXTURE/.worktrees/w7/PLAN.md"; then
	pass "plan-first: PLAN.md written by the plan session"
else
	fail "plan-first: PLAN.md missing or wrong content"
fi
if grep -q "## Implementation plan (from the plan-first phase)" "$FIXTURE/.worktrees/w7/ORCHESTRATOR_TASK.md" &&
	grep -q "mock plan-first" "$FIXTURE/.worktrees/w7/ORCHESTRATOR_TASK.md"; then
	pass "plan-first: plan appended into ORCHESTRATOR_TASK.md for the code worker"
else
	fail "plan-first: ORCHESTRATOR_TASK.md lacks the appended plan section"
fi

# The code worker still ran normally after the plan phase and completed.
W7_DONE=0
for _ in $(seq 1 120); do
	if [ -d "$FIXTURE/.worktrees/w7/.harness.done" ]; then
		W7_DONE=1
		break
	fi
	sleep 1
done
W7_EXIT="$(cat "$FIXTURE/.worktrees/w7/.harness.exit" 2>/dev/null || echo '')"
if [ "$W7_DONE" -eq 1 ] && [ "$W7_EXIT" = "0" ]; then
	pass "plan-first: code worker completed after the plan phase (exit 0)"
else
	fail "plan-first: worker did not complete after the plan (exit $W7_EXIT)"
	tail -n 20 "$FIXTURE/.worktrees/w7/harness.log" 2>/dev/null >&2 || true
fi
if grep -q 'return "Hello, " + name' "$FIXTURE/.worktrees/w7/src/greet.js"; then
	pass "plan-first: worker really fixed the fixture bug"
else
	fail "plan-first: expected the mock-derived fix in w7"
fi

# The plan session used the architect mode's model; the worker used the code
# model. Both must appear in the plan-first mock's request log.
if grep -q "model=deepseek/architect-plan" "$PLAN_MOCK_LOG" &&
	grep -q "model=deepseek/deepseek-v4-flash-0731" "$PLAN_MOCK_LOG"; then
	pass "plan-first: mock saw the plan session (architect model) + the worker (code model)"
else
	fail "plan-first: mock log missing the plan and/or worker model requests"
	tail -n 15 "$PLAN_MOCK_LOG" >&2
fi

# The state file records the plan-first outcome for the group (multi-line JSON
# from merge_state's pretty-printer, so match with -A4).
if grep -q '"name": "w7"' "$FIXTURE/.worktrees/.orchestrator-state.json" &&
	grep -A4 '"plan_first"' "$FIXTURE/.worktrees/.orchestrator-state.json" | grep -q '"mode": "architect"' &&
	grep -A4 '"plan_first"' "$FIXTURE/.worktrees/.orchestrator-state.json" | grep -q '"status": "ok"' &&
	grep -A4 '"plan_first"' "$FIXTURE/.worktrees/.orchestrator-state.json" | grep -q '"report": "PLAN.md"'; then
	pass "plan-first: state records plan_first ok for w7"
else
	fail "plan-first: state file missing the plan_first ok record for w7"
	grep -o '"name": "w7".*' "$FIXTURE/.worktrees/.orchestrator-state.json" >&2 || true
fi

# ── 10. Summary + cleanup ────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo ""
echo "──────────────────────────────────────────────────────────────"
echo "  fixture:        $FIXTURE"
echo "  worker mock:    $WORKER_PORT ($WORKER_REQ_COUNT requests)"
echo "  review mock:    $REVIEW_PORT"
echo "  plan-first mock: $PLAN_PORT (issue #49)"
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
