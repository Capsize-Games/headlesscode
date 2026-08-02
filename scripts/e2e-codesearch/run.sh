#!/usr/bin/env bash
#
# run.sh — codebase_search activation end-to-end test.
#
# Proves the code-mode guidance (`.roo/rules-code/rules.md`) actually
# changes behavior: a real `code`-mode harness session against the mock
# OpenRouter (search-before-read scenario) must reach for `codebase_search`
# BEFORE `read_file` on an orientation-style task.
#
# What it exercises end-to-end:
#   1. A REAL `headlesscode` CLI session with `--mode code` against a local
#      mock OpenRouter server (no real API key, no network).
#   2. The mock's search-before-read scenario emits a `codebase_search`
#      tool call on the FIRST request only when the request's tool list
#      includes codebase_search; otherwise it emits read_file. Either way
#      the run terminates cleanly (exit 0) — the mock NEVER errors, so the
#      run's outcome does not depend on the model's choice.
#   3. The runner then greps the mock's request log for the tool the model
#      actually reached for first. With the new guidance spliced into the
#      system prompt, the model should call codebase_search first.
#
# Usage: scripts/e2e-codesearch/run.sh
#   KEEP=1   keep fixture/worktree temp dirs (default: remove)
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
		git -C "$FIXTURE" worktree remove --force "$WORKTREE" 2>/dev/null || true
	fi
	rm -rf "${FIXTURE:-}" "${WORKTREE:-}" "${HARNESS_OUT:-}" "${MOCK_LOG:-}"
	echo "  cleaned up temp fixture/worktree/logs (set KEEP=1 to retain)"
}

# ── 1. Fixture repo ──────────────────────────────────────────────────────────
echo "== [1/5] fixture repo =="
FIXTURE="$(bash "$ROOT/scripts/e2e-fixture/setup.sh")"
if [ -z "$FIXTURE" ] || [ ! -d "$FIXTURE/.git" ]; then
	echo "  fixture setup failed; aborting" >&2
	exit 1
fi
echo "  fixture: $FIXTURE"

# ── 2. Isolated worktree (the harness works HERE, fixture stays untouched) ──
echo "== [2/5] isolated worktree =="
WORKTREE="$(mktemp -d /tmp/headlesscode-e2e-codesearch-wt-XXXXXX)"
bash "$ROOT/scripts/e2e-fixture/spawn-worktree.sh" "$FIXTURE" "$WORKTREE" >/dev/null
if ! git -C "$WORKTREE" rev-parse --git-dir >/dev/null 2>&1; then
	echo "  worktree spawn failed; aborting" >&2
	exit 1
fi
echo "  worktree: $WORKTREE"

# ── 3. Mock OpenRouter server (search-before-read scenario) ─────────────────
echo "== [3/5] mock OpenRouter server (search-before-read) =="
MOCK_LOG="$(mktemp /tmp/headlesscode-e2e-codesearch-mock-XXXXXX.log)"
(
	cd "$ROOT" &&
		exec env PORT=0 MOCK_SCENARIO="search-before-read" MOCK_FIXTURE_ROOT="$FIXTURE" \
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
echo "  mock listening on 127.0.0.1:$MOCK_PORT (pid $MOCK_PID)"
sleep 0.2

# ── 4. Real harness run (real CLI + real HTTP against the mock) ──────────────
echo "== [4/5] harness run (real CLI, real HTTP, mock LLM) =="
HARNESS_OUT="$(mktemp /tmp/headlesscode-e2e-codesearch-cli-XXXXXX.out)"
# Orientation-style task: "where is X / how does Y work" — exactly the
# shape of task the new code-mode guidance says to open with codebase_search.
TASK_TEXT='Where is the greet function and how does it handle the name argument? Do not edit anything — just locate it and report back.'

(
	cd "$ROOT" &&
		OPENROUTER_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
		HEADLESSCODE_OPENROUTER_API_KEY="test-key" \
		HEADLESSCODE_WORKSPACE_ROOT="$WORKTREE" \
		npx tsx src/cli.ts --task "$TASK_TEXT" --mode code \
			--workspace "$WORKTREE" --max-iterations 10
) >"$HARNESS_OUT" 2>&1
CLI_EXIT=$?
echo "  cli exit code: $CLI_EXIT"

# ── 5. Assertions ────────────────────────────────────────────────────────────
echo "== [5/5] assertions =="

if [ "$CLI_EXIT" -eq 0 ]; then
	pass "CLI exited 0 (session terminated cleanly)"
else
	fail "CLI exited $CLI_EXIT (expected 0); output tail:"
	tail -n 25 "$HARNESS_OUT" >&2
fi

# The mock emits the model's reply tool calls in its response log — THAT is
# what the (scripted) model actually reached for first, independent of the
# run's exit code. Grep for a codebase_search call the mock emitted as the
# model's first-reply tool.
if grep -q "tool_calls=codebase_search" "$MOCK_LOG"; then
	pass "model's first reply reached for codebase_search (guidance effective)"
else
	fail "model's first reply did NOT reach for codebase_search (guidance not effective); mock log:"
	cat "$MOCK_LOG" >&2
fi

# The system prompt must actually contain the new guidance — otherwise the
# model could only have reached for codebase_search because the tool was
# advertised, not because the guidance told it to. The dry-run path prints
# the prompt; grep for a phrase unique to this repo's
# .roo/rules-code/rules.md. The fixture worktree has its own rules, so run
# the dry-run against the headlesscode repo root ($ROOT), where the real
# guidance lives. (The phrase in the rules file is backtick-wrapped, so
# grep for the content between the backticks.)
DRYRUN_OUT="$(mktemp /tmp/headlesscode-e2e-codesearch-dryrun-XXXXXX.out)"
(
	cd "$ROOT" &&
		npx tsx src/cli.ts --dry-run --mode code --workspace "$ROOT"
) >"$DRYRUN_OUT" 2>&1
DRYRUN_EXIT=$?
if [ "$DRYRUN_EXIT" -eq 0 ] && grep -q "codebase_search\` complements" "$DRYRUN_OUT"; then
	pass "code-mode guidance (codebase_search complements) present in the code-mode system prompt"
else
	fail "code-mode guidance missing from the system prompt (dry-run exit $DRYRUN_EXIT)"
fi

# ── Summary + cleanup ────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo ""
echo "──────────────────────────────────────────────────────────────"
echo "  fixture:        $FIXTURE"
echo "  worktree:       $WORKTREE"
echo "  mock port:      $MOCK_PORT"
echo "  cli exit code:  $CLI_EXIT"
echo "  results:        PASS $PASS / $TOTAL   FAIL $FAIL / $TOTAL"
if [ "$FAIL" -eq 0 ]; then
	echo "  RESULT: PASS"
else
	echo "  RESULT: FAIL"
fi
echo "  harness output: $HARNESS_OUT"
echo "  mock log:       $MOCK_LOG"
echo "──────────────────────────────────────────────────────────────"
cleanup

[ "$FAIL" -eq 0 ]
