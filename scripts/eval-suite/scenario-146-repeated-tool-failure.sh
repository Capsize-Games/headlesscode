#!/usr/bin/env bash
set -euo pipefail

# Live eval for issue #146's repeated-tool-failure guardrail (loop.ts).
#
# Sets up a fixture that reliably induces edit_file failures in a local
# model (a whitespace-only indentation fix — the exact shape issue #141
# documented as failing ~10/10 times against qwen3-14b, even when the
# model is given the precise current and desired content verbatim), runs
# a REAL headless session against the code-daemon (qwen3-14b), and checks
# the real transcript for:
#   1. Did edit_file actually fail more than once (the precondition)?
#   2. Did the NEW repeated-tool-failure nudge (loop.ts, issue #146) fire?
#   3. Did the session ultimately land a real, correct edit (recovery), or
#      did it exhaust its budget still failing?
#
# Usage: scripts/eval-suite/scenario-146-repeated-tool-failure.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
# The fixture workspace is git-init'd (a separate, standalone repo the
# session runs against) — it MUST live OUTSIDE this repo's own tree, or
# it becomes a nested git repo that this repo's own checkpoint system
# then detects and refuses to work with (live-verified 2026-08-21: this
# happened for real, disabling checkpoints — "non-fatal" but real
# pollution — for every subsequent session in THIS repo until the old
# fixture dirs were manually removed). ${TMPDIR:-/tmp} is the right home
# for it — this is a throwaway fixture repo, not a headlesscode session's
# own scratch output (the "never write to /tmp" rule is about a
# DISPATCHED session's own writes relative to ITS --workspace, not where
# a wrapper script creates a fresh, separate --workspace to point one at).
WS="$(mktemp -d "${TMPDIR:-/tmp}/headlesscode-eval-146-XXXXXX")"
LOG="$REPO_ROOT/.headlesscode/scratch/eval-suite/146-repeated-failure-$STAMP.log"

cd "$WS"
git init -q
git config user.email "eval@local"
git config user.name "eval"

cat > config.ts <<'EOF'
export function buildConfig(env: string): Record<string, unknown> {
	const base = {
		retries: 3,
		timeoutMs: 5000,
	}
	if (env === "production") {
		return {
			...base,
// TODO: production config still needs real secrets wiring
			strict: true,
		}
	}
	return base
}
EOF
git add -A
git commit -q -m "initial fixture"

TASK_FILE="${TMPDIR:-/tmp}/headlesscode-eval-146-task-$STAMP.md"
cat > "$TASK_FILE" <<'EOF'
## Rules
- Unattended: never use ask_followup_question.
- This is a whitespace-ONLY fix. Do not change anything else about the file.

## Task
In `config.ts`, the comment line `// TODO: production config still needs real secrets wiring`
is missing its indentation — every other line inside that `if` block starts
with 3 tabs, but this comment line starts with 0 tabs. Fix ONLY this
line's indentation to match the surrounding block (3 leading tabs before
`// TODO:`), using edit_file. Do not change the comment text itself, and
do not change any other line. When done, call attempt_completion.
EOF

echo "Workspace: $WS"
echo "Task file: $TASK_FILE"
echo "Log file:  $LOG"
echo "--- running real session against code-daemon (qwen3-14b) ---"

cd "$REPO_ROOT"
HEADLESSCODE_CODE_MODE_BACKEND=ollama \
HEADLESSCODE_LOCAL_BACKEND_MODES=code \
HEADLESSCODE_OLLAMA_URL=http://localhost:11435 \
HEADLESSCODE_CODE_MODE_MODEL=qwen3-14b:latest \
npx tsx src/cli.ts \
	--mode code \
	--task-file "$TASK_FILE" \
	--workspace "$WS" \
	--max-iterations 20 \
	--log-file "$LOG" \
	> "$LOG.stdout" 2>&1 || true

echo "--- session finished, exit status: $? (informational — session may legitimately end in bounded failure) ---"
echo "$WS" > "$REPO_ROOT/.headlesscode/scratch/eval-suite/146-repeated-failure-$STAMP.workspace"
echo "$LOG"
