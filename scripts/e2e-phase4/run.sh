#!/usr/bin/env bash
#
# run.sh — headlesscode Phase 4 end-to-end integration test (QA + deploy gate).
# No API key, no network, no real deploy, no real git remotes beyond a local
# throwaway bare repo.
#
# Exercises the REAL Phase 4 pieces end-to-end:
#   1. Full `orchestrate --qa` round against the fixture with the auto mock
#      (worker success -> review clean -> QA pass), asserting the state file
#      gains a `qa` record with verdict pass.
#   2. QA tool discipline: the QA session is exposed read + command tools only
#      (mock log never shows write_to_file) and parses QA_VERDICT.
#   3. scripts/run-qa.sh wrapper: .qa.pid / .qa.exit / .qa.done / qa.log.
#   4. Deploy gate standalone: DENIED with a wrong token (exit 3, marker
#      absent), approved with a matching token (fake deploy script writes a
#      marker), approved via a human-created one-time approval file, and path
#      safety (deploy script escaping the repo root is refused).
#   5. `orchestrate --deploy` wiring: after a passing round the gate runs and
#      the fake deploy script is invoked; with a wrong token the round ends
#      DENIED (exit 1) and the deploy script is NOT invoked.
#
# Usage: scripts/e2e-phase4/run.sh
#   KEEP=1   keep temp fixture/bare/worktrees/logs (default: remove)
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
WORKTREE_NAMES=""

cleanup() {
	if [ "$KEEP" = "1" ]; then
		echo "  KEEP=1: leaving fixture/bare/worktrees/logs in place"
		return
	fi
	if [ -n "${FIXTURE:-}" ]; then
		for n in $WORKTREE_NAMES; do
			pidfile="$FIXTURE/.worktrees/$n/.harness.pid"
			if [ -f "$pidfile" ]; then
				pid="$(cat "$pidfile" 2>/dev/null || true)"
				[ -n "$pid" ] && kill "$pid" 2>/dev/null || true
			fi
			qapidfile="$FIXTURE/.worktrees/$n/.qa.pid"
			if [ -f "$qapidfile" ]; then
				pid="$(cat "$qapidfile" 2>/dev/null || true)"
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
	rm -rf "${FIXTURE:-}" "${BARE:-}" "${DEPLOY_TARGET:-}" \
		"${ISSUES_JSON:-}" "${ORCH1_OUT:-}" "${ORCH2_OUT:-}" "${ORCH3_OUT:-}" \
		"${QA_INVOKE_PASS_OUT:-}" "${QA_INVOKE_FAIL_OUT:-}" "${RUNQA_OUT:-}" \
		"${AUTO_MOCK_LOG:-}" "${QA_PASS_MOCK_LOG:-}" "${QA_FAIL_MOCK_LOG:-}" \
		"${GATE_DENIED_OUT:-}" "${GATE_APPROVED_OUT:-}" "${GATE_FILE_OUT:-}" "${GATE_ESCAPE_OUT:-}" "${GATE_MISSING_OUT:-}"
	echo "  cleaned up temp fixture/bare/worktrees/logs (set KEEP=1 to retain)"
}

start_mock() {
	local scenario="$1"
	local logfile="$2"
	local portvar="$3"
	(
		cd "$ROOT" &&
			env PORT=0 MOCK_SCENARIO="$scenario" MOCK_FIXTURE_ROOT="${FIXTURE:-}" \
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

# ── 1. Fixture repo + bare origin + qa-agent mode + fake deploy script ───────
echo "== [1/10] fixture repo + origin =="
FIXTURE="$(bash "$ROOT/scripts/e2e-fixture/setup.sh")"
if [ -z "$FIXTURE" ] || [ ! -d "$FIXTURE/.git" ]; then
	echo "  fixture setup failed; aborting" >&2
	exit 1
fi

# Add a qa-agent custom mode (Phase 4: the harness splices it via .roomodes,
# and the auto mock classifies QA sessions by the "QA agent" role text).
cat > "$FIXTURE/.roomodes" <<'EOF'
customModes:
  - slug: issue-fixer
    name: 🔧 Issue Fixer (fixture)
    roleDefinition: |-
      You are a headless issue-fixing specialist. You analyze the task, read the
      relevant source, implement the fix with write_to_file, verify it with
      execute_command, and report via attempt_completion.
    whenToUse: Use when a fixture issue must be resolved end-to-end.
    description: Resolve fixture issue #29.
    groups:
      - read
      - edit
      - command
    source: project
  - slug: qa-agent
    name: QA Agent
    roleDefinition: |-
      You are a QA agent for this project. Your job is to verify the changed
      behavior and report evidence with real command output. You do not write
      or edit source files.
    customInstructions: |-
      **You are a QA agent for this project.**

      ## How to perform QA
      - Run the project's test suite (`node src/greet.test.js`) and capture the REAL output.
      - Exercise the changed behavior: greet() must return "Hello, " + name.
      - Report evidence with real command output.

      ## How to finish
      Call attempt_completion with a structured summary: a verdict line
      (QA PASS or QA FAIL), an Evidence section with the real commands you
      ran and their output, and the final baseline numbers you confirmed.
    groups:
      - read
      - command
    source: project
EOF

# Fake deploy script: NEVER deploys anything — writes a marker file with the
# args it was called with, so the e2e can assert "only called after approval".
mkdir -p "$FIXTURE/scripts"
cat > "$FIXTURE/scripts/deploy-production.sh" <<'EOF'
#!/usr/bin/env bash
# FAKE deploy-production.sh for the Phase 4 e2e — records the invocation,
# never deploys anything for real.
set -euo pipefail
echo "deploy-called args=[$*] at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$PWD/.e2e-deploy-ran"
EOF
chmod +x "$FIXTURE/scripts/deploy-production.sh"
git -C "$FIXTURE" add -A
git -C "$FIXTURE" -c user.name="E2E" -c user.email="e2e@headlesscode.invalid" -c commit.gpgsign=false \
	commit -q -m "fixture: add qa-agent mode + fake deploy script (phase 4)"

BARE="$(mktemp -d /tmp/headlesscode-e2e4-bare-XXXXXX)"
git -C "$FIXTURE" branch -M master
git init --bare -q "$BARE"
git -C "$FIXTURE" remote add origin "$BARE"
git -C "$FIXTURE" -c user.name="E2E" -c user.email="e2e@headlesscode.invalid" -c commit.gpgsign=false \
	push -q -u origin master
echo "  fixture: $FIXTURE (origin -> $BARE)"

# ── 2. Issues JSON (one group: w1-issue1) ───────────────────────────────────
echo "== [2/10] issues-json =="
ISSUES_JSON="$(mktemp /tmp/headlesscode-e2e4-issues-XXXXXX.json)"
cat > "$ISSUES_JSON" <<'EOF'
[
  { "number": 1, "title": "Fix the greet bug", "body": "greet() must return 'Hello, ' + name" }
]
EOF

# ── 3. Mock servers ──────────────────────────────────────────────────────────
echo "== [3/10] mock OpenRouter servers =="
AUTO_MOCK_LOG="$(mktemp /tmp/headlesscode-e2e4-auto-mock-XXXXXX.log)"
QA_PASS_MOCK_LOG="$(mktemp /tmp/headlesscode-e2e4-qapass-mock-XXXXXX.log)"
QA_FAIL_MOCK_LOG="$(mktemp /tmp/headlesscode-e2e4-qafail-mock-XXXXXX.log)"
start_mock qa-orchestrate "$AUTO_MOCK_LOG" AUTO_PORT
start_mock qa-pass "$QA_PASS_MOCK_LOG" QA_PASS_PORT
start_mock qa-fail "$QA_FAIL_MOCK_LOG" QA_FAIL_PORT
sleep 0.2

# ── 4. Full orchestrate --qa round (worker -> review -> QA) ─────────────────
echo "== [4/10] orchestrate --qa (full round) =="
ORCH1_OUT="$(mktemp /tmp/headlesscode-e2e4-orch1-XXXXXX.out)"
(
	cd "$ROOT" &&
		OPENROUTER_API_KEY="test-key" \
		OPENROUTER_BASE_URL="http://127.0.0.1:$AUTO_PORT" \
		HEADLESSCODE_ROOT="$ROOT" \
		npx tsx src/cli.ts orchestrate --repo "$FIXTURE" --issues-json "$ISSUES_JSON" \
			--qa --qa-mode qa-agent --poll-interval-ms 200
) >"$ORCH1_OUT" 2>&1
ORCH1_EXIT=$?
echo "  orchestrate --qa exit: $ORCH1_EXIT"
if [ "$ORCH1_EXIT" -eq 0 ] &&
	grep -q "QA verdict: pass" "$ORCH1_OUT" &&
	grep -q "review verdict: clean" "$ORCH1_OUT"; then
	pass "orchestrate --qa round completed (review clean + QA pass)"
else
	fail "orchestrate --qa round failed (exit $ORCH1_EXIT)"
	tail -n 30 "$ORCH1_OUT" >&2
fi
STATE_FILE="$FIXTURE/.worktrees/.orchestrator-state.json"
if [ -f "$STATE_FILE" ] && grep -q '"qa": {' "$STATE_FILE" && grep -q '"verdict": "pass"' "$STATE_FILE"; then
	pass "state file records qa { verdict: pass } per group"
else
	fail "state file missing qa record with verdict pass"
	[ -f "$STATE_FILE" ] && cat "$STATE_FILE" >&2 || true
fi
if grep -q '"review_verdict": "clean"' "$STATE_FILE"; then
	pass "state file records review_verdict clean"
else
	fail "state file missing clean review verdict"
fi
if grep -q 'return "Hello, " + name' "$FIXTURE/.worktrees/w1/src/greet.js"; then
	pass "worker really fixed the fixture bug (mock-derived fix landed)"
else
	fail "expected the mock-derived fix in the worktree"
fi
WORKTREE_NAMES="w1"

# ── 5. QA tool discipline (qa-pass mock: no write_to_file ever) ─────────────
echo "== [5/10] QA tool discipline (qa-pass invocation) =="
QA_INVOKE_PASS_OUT="$(mktemp /tmp/headlesscode-e2e4-qapass-XXXXXX.out)"
(
	cd "$ROOT" &&
		OPENROUTER_BASE_URL="http://127.0.0.1:$QA_PASS_PORT" \
		OPENROUTER_API_KEY="test-key" \
		npx tsx scripts/e2e-phase4/qa-invoke.ts --workspace "$FIXTURE/.worktrees/w1"
) >"$QA_INVOKE_PASS_OUT" 2>&1
QA_PASS_EXIT=$?
echo "  qa-invoke (pass) exit: $QA_PASS_EXIT"
if grep -q "QA_VERDICT=pass" "$QA_INVOKE_PASS_OUT"; then
	pass "qa-invoke parsed QA_VERDICT=pass"
else
	fail "expected QA_VERDICT=pass (exit $QA_PASS_EXIT)"
	tail -n 15 "$QA_INVOKE_PASS_OUT" >&2
fi
if grep -q "QA_EVIDENCE=" "$QA_INVOKE_PASS_OUT" && ! grep -q "QA_EVIDENCE=$" "$QA_INVOKE_PASS_OUT"; then
	pass "QA evidence extracted and non-empty"
else
	fail "QA evidence missing or empty"
fi
if ! grep -q "write_to_file" "$QA_PASS_MOCK_LOG"; then
	pass "QA session was never exposed write_to_file (read + command only)"
else
	fail "QA session tool list contains write_to_file"
	grep "tools=" "$QA_PASS_MOCK_LOG" | tail -n 3 >&2
fi

# ── 6. QA fail path (qa-fail mock) ───────────────────────────────────────────
echo "== [6/10] QA fail path (qa-fail invocation) =="
QA_INVOKE_FAIL_OUT="$(mktemp /tmp/headlesscode-e2e4-qafail-XXXXXX.out)"
(
	cd "$ROOT" &&
		OPENROUTER_BASE_URL="http://127.0.0.1:$QA_FAIL_PORT" \
		OPENROUTER_API_KEY="test-key" \
		npx tsx scripts/e2e-phase4/qa-invoke.ts --workspace "$FIXTURE/.worktrees/w1"
) >"$QA_INVOKE_FAIL_OUT" 2>&1
QA_FAIL_EXIT=$?
echo "  qa-invoke (fail) exit: $QA_FAIL_EXIT"
if grep -q "QA_VERDICT=fail" "$QA_INVOKE_FAIL_OUT"; then
	pass "qa-invoke parsed QA_VERDICT=fail"
else
	fail "expected QA_VERDICT=fail (exit $QA_FAIL_EXIT)"
	tail -n 15 "$QA_INVOKE_FAIL_OUT" >&2
fi

# ── 7. run-qa.sh wrapper ─────────────────────────────────────────────────────
echo "== [7/10] scripts/run-qa.sh wrapper =="
RUNQA_OUT="$(mktemp /tmp/headlesscode-e2e4-runqa-XXXXXX.out)"
QA_PID="$(OPENROUTER_BASE_URL="http://127.0.0.1:$QA_PASS_PORT" OPENROUTER_API_KEY="test-key" \
	HEADLESSCODE_ROOT="$ROOT" \
	bash "$ROOT/scripts/run-qa.sh" "$FIXTURE/.worktrees/w1" --mode qa-agent)"
QA_PID="$(printf '%s' "$QA_PID" | tail -n 1)"
echo "  run-qa.sh pid: $QA_PID"
QA_DONE=0
for _ in $(seq 1 120); do
	if [ -d "$FIXTURE/.worktrees/w1/.qa.done" ]; then
		QA_DONE=1
		break
	fi
	sleep 1
done
if [ "$QA_DONE" -eq 1 ]; then
	pass "run-qa.sh completed (.qa.done marker present)"
else
	fail "run-qa.sh did not complete within 120s; qa.log tail:"
	tail -n 20 "$FIXTURE/.worktrees/w1/qa.log" 2>/dev/null >&2 || true
fi
QA_EXIT="$(cat "$FIXTURE/.worktrees/w1/.qa.exit" 2>/dev/null || echo '')"
if [ "$QA_EXIT" = "0" ]; then
	pass "run-qa.sh exit code 0 recorded in .qa.exit"
else
	fail "expected .qa.exit 0, got '$QA_EXIT'"
fi
if [ -s "$FIXTURE/.worktrees/w1/qa.log" ]; then
	pass "qa.log exists and is non-empty"
else
	fail "qa.log missing/empty"
fi
if [ -f "$FIXTURE/.worktrees/w1/.qa-task.md" ] && grep -q "QA PASS" "$FIXTURE/.worktrees/w1/.qa-task.md"; then
	pass "run-qa.sh wrote the QA checklist task file (.qa-task.md)"
else
	fail ".qa-task.md missing or without QA checklist"
fi

# ── 8. Deploy gate standalone (temp target repo + fake deploy script) ───────
echo "== [8/10] deploy gate standalone =="
DEPLOY_TARGET="$(mktemp -d /tmp/headlesscode-e2e4-deploy-XXXXXX)"
mkdir -p "$DEPLOY_TARGET/scripts"
cat > "$DEPLOY_TARGET/scripts/deploy-production.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "deploy-called args=[$*] at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$PWD/.e2e-deploy-ran"
EOF
chmod +x "$DEPLOY_TARGET/scripts/deploy-production.sh"
printf '%s\n' "correct-token" > "$DEPLOY_TARGET/.deploy-approval"

# 8a. Wrong token -> denied (exit 3), deploy script NOT called.
GATE_DENIED_OUT="$(mktemp /tmp/headlesscode-e2e4-gate-denied-XXXXXX.out)"
(
	cd "$ROOT" &&
		DEPLOY_APPROVAL_TOKEN="wrong-token" \
		bash scripts/deploy-gate.sh "$DEPLOY_TARGET" --batch e2e
) >"$GATE_DENIED_OUT" 2>&1
GATE_DENIED_EXIT=$?
echo "  gate (wrong token) exit: $GATE_DENIED_EXIT"
if [ "$GATE_DENIED_EXIT" -eq 3 ]; then
	pass "gate DENIED with a wrong token (exit 3)"
else
	fail "expected exit 3 for wrong token (got $GATE_DENIED_EXIT)"
	tail -n 15 "$GATE_DENIED_OUT" >&2
fi
if [ ! -f "$DEPLOY_TARGET/.e2e-deploy-ran" ]; then
	pass "deploy script NOT called on denial (no marker)"
else
	fail "deploy script WAS called despite denial"
fi
if grep -q "DENIED" "$GATE_DENIED_OUT"; then
	pass "denial printed a clear message"
else
	fail "denial message missing"
fi

# 8b. Matching token -> approved, fake deploy script invoked with args.
GATE_APPROVED_OUT="$(mktemp /tmp/headlesscode-e2e4-gate-approved-XXXXXX.out)"
(
	cd "$ROOT" &&
		DEPLOY_APPROVAL_TOKEN="correct-token" \
		bash scripts/deploy-gate.sh "$DEPLOY_TARGET" --batch e2e --deploy-args "--local --fastsearch-only"
) >"$GATE_APPROVED_OUT" 2>&1
GATE_APPROVED_EXIT=$?
echo "  gate (matching token) exit: $GATE_APPROVED_EXIT"
if [ "$GATE_APPROVED_EXIT" -eq 0 ]; then
	pass "gate approved with a matching token"
else
	fail "expected exit 0 for matching token (got $GATE_APPROVED_EXIT)"
	tail -n 15 "$GATE_APPROVED_OUT" >&2
fi
if [ -f "$DEPLOY_TARGET/.e2e-deploy-ran" ] && grep -q "args=\[--local --fastsearch-only\]" "$DEPLOY_TARGET/.e2e-deploy-ran"; then
	pass "fake deploy script invoked only after approval, with forwarded args"
else
	fail "expected deploy marker with forwarded args after approval"
	[ -f "$DEPLOY_TARGET/.e2e-deploy-ran" ] && cat "$DEPLOY_TARGET/.e2e-deploy-ran" >&2 || true
fi

# 8c. One-time approval file mode (no token).
rm -f "$DEPLOY_TARGET/.e2e-deploy-ran"
mkdir -p "$DEPLOY_TARGET/.worktrees"
touch "$DEPLOY_TARGET/.worktrees/.deploy-approved-e2e"
GATE_FILE_OUT="$(mktemp /tmp/headlesscode-e2e4-gate-file-XXXXXX.out)"
(
	cd "$ROOT" &&
		env -u DEPLOY_APPROVAL_TOKEN \
			bash scripts/deploy-gate.sh "$DEPLOY_TARGET" --batch e2e
) >"$GATE_FILE_OUT" 2>&1
GATE_FILE_EXIT=$?
echo "  gate (approval file) exit: $GATE_FILE_EXIT"
if [ "$GATE_FILE_EXIT" -eq 0 ] && [ -f "$DEPLOY_TARGET/.e2e-deploy-ran" ]; then
	pass "one-time approval file (touch .deploy-approved-<batch>) approves"
else
	fail "approval file mode should approve + invoke deploy"
	tail -n 15 "$GATE_FILE_OUT" >&2
fi

# 8d. Path safety: deploy script escaping the repo root is refused.
rm -f "$DEPLOY_TARGET/.e2e-deploy-ran"
GATE_ESCAPE_OUT="$(mktemp /tmp/headlesscode-e2e4-gate-escape-XXXXXX.out)"
(
	cd "$ROOT" &&
		DEPLOY_APPROVAL_TOKEN="correct-token" \
		bash scripts/deploy-gate.sh "$DEPLOY_TARGET" --batch e2e --deploy-script "../../../../tmp/evil-deploy.sh"
) >"$GATE_ESCAPE_OUT" 2>&1
GATE_ESCAPE_EXIT=$?
echo "  gate (escaping script) exit: $GATE_ESCAPE_EXIT"
if [ "$GATE_ESCAPE_EXIT" -eq 2 ] && [ ! -f "$DEPLOY_TARGET/.e2e-deploy-ran" ]; then
	pass "gate refuses a deploy script path outside the repo root (exit 2, no run)"
else
	fail "escaping deploy script path should be refused (exit 2)"
	tail -n 10 "$GATE_ESCAPE_OUT" >&2
fi

# 8e. Missing deploy script -> clear error, nothing runs.
GATE_MISSING_OUT="$(mktemp /tmp/headlesscode-e2e4-gate-missing-XXXXXX.out)"
(
	cd "$ROOT" &&
		DEPLOY_APPROVAL_TOKEN="correct-token" \
		bash scripts/deploy-gate.sh "$DEPLOY_TARGET" --batch e2e --deploy-script "scripts/nope.sh"
) >"$GATE_MISSING_OUT" 2>&1
GATE_MISSING_EXIT=$?
echo "  gate (missing script) exit: $GATE_MISSING_EXIT"
if [ "$GATE_MISSING_EXIT" -eq 2 ] && grep -q "not found" "$GATE_MISSING_OUT"; then
	pass "gate errors clearly when the deploy script is missing"
else
	fail "missing deploy script should error clearly (exit 2)"
	tail -n 10 "$GATE_MISSING_OUT" >&2
fi

# ── 9. orchestrate --deploy wiring ───────────────────────────────────────────
echo "== [9/10] orchestrate --deploy wiring =="
printf '%s\n' "correct-token" > "$FIXTURE/.deploy-approval"
rm -f "$FIXTURE/.e2e-deploy-ran"

# 9a. Round already passing + matching token -> gate approves, deploy invoked.
ORCH2_OUT="$(mktemp /tmp/headlesscode-e2e4-orch2-XXXXXX.out)"
(
	cd "$ROOT" &&
		OPENROUTER_API_KEY="test-key" \
		OPENROUTER_BASE_URL="http://127.0.0.1:$AUTO_PORT" \
		HEADLESSCODE_ROOT="$ROOT" \
		DEPLOY_APPROVAL_TOKEN="correct-token" \
		npx tsx src/cli.ts orchestrate --repo "$FIXTURE" --issues-json "$ISSUES_JSON" \
			--qa --qa-mode qa-agent --deploy --deploy-args "--local --fastsearch-only" --poll-interval-ms 200
) >"$ORCH2_OUT" 2>&1
ORCH2_EXIT=$?
echo "  orchestrate --deploy (approved) exit: $ORCH2_EXIT"
if [ "$ORCH2_EXIT" -eq 0 ] &&
	grep -q "deploy approved by the gate and executed" "$ORCH2_OUT" &&
	[ -f "$FIXTURE/.e2e-deploy-ran" ] &&
	grep -q "args=\[--local --fastsearch-only\]" "$FIXTURE/.e2e-deploy-ran"; then
	pass "orchestrate --deploy ran the gate and invoked the fake deploy after approval"
else
	fail "orchestrate --deploy should approve + invoke the fake deploy (exit $ORCH2_EXIT)"
	tail -n 25 "$ORCH2_OUT" >&2
fi

# 9b. Wrong token -> gate DENIES, orchestrate returns 1, deploy NOT invoked.
ORCH2_MARKER_LINES="$(wc -l < "$FIXTURE/.e2e-deploy-ran" 2>/dev/null || echo 0)"
ORCH3_OUT="$(mktemp /tmp/headlesscode-e2e4-orch3-XXXXXX.out)"
(
	cd "$ROOT" &&
		OPENROUTER_API_KEY="test-key" \
		OPENROUTER_BASE_URL="http://127.0.0.1:$AUTO_PORT" \
		HEADLESSCODE_ROOT="$ROOT" \
		DEPLOY_APPROVAL_TOKEN="wrong-token" \
		npx tsx src/cli.ts orchestrate --repo "$FIXTURE" --issues-json "$ISSUES_JSON" \
			--qa --qa-mode qa-agent --deploy --poll-interval-ms 200
) >"$ORCH3_OUT" 2>&1
ORCH3_EXIT=$?
echo "  orchestrate --deploy (denied) exit: $ORCH3_EXIT"
ORCH3_MARKER_LINES="$(wc -l < "$FIXTURE/.e2e-deploy-ran" 2>/dev/null || echo 0)"
if [ "$ORCH3_EXIT" -eq 1 ] &&
	grep -q "deploy DENIED by the human-approval gate" "$ORCH3_OUT" &&
	[ "$ORCH3_MARKER_LINES" = "$ORCH2_MARKER_LINES" ]; then
	pass "orchestrate --deploy with a wrong token is a hard stop: exit 1, deploy NOT invoked"
else
	fail "orchestrate --deploy should deny on wrong token (exit $ORCH3_EXIT, marker $ORCH2_MARKER_LINES -> $ORCH3_MARKER_LINES)"
	tail -n 25 "$ORCH3_OUT" >&2
fi

# ── 10. Summary + cleanup ────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo ""
echo "──────────────────────────────────────────────────────────────"
echo "  fixture:         $FIXTURE"
echo "  results:         PASS $PASS / $TOTAL   FAIL $FAIL / $TOTAL"
if [ "$FAIL" -eq 0 ]; then
	echo "  RESULT: PASS"
else
	echo "  RESULT: FAIL"
fi
echo "──────────────────────────────────────────────────────────────"
cleanup

[ "$FAIL" -eq 0 ]
