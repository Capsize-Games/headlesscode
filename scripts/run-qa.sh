#!/usr/bin/env bash
# run-qa.sh — launch ONE headless harness QA session as a background process
# against a worktree, mirroring scripts/run-worker.sh (Phase 4).
#
# QA lifecycle:
#   1. Writes a QA checklist task file to <worktree>/.qa-task.md. The default
#      checklist is the generic one (boot the app, run the relevant test
#      suite, exercise the changed behavior, report evidence with real command
#      output). If the target repo defines a `qa-agent` mode (or whatever
#      --mode is passed), that mode's OWN checklist is spliced into the system
#      prompt automatically by the harness (same mechanism as the reviewer),
#      so the task file is a thin pointer to it.
#   2. Runs `$HEADLESSCODE_CLI --task-file .qa-task.md --workspace <worktree>
#      --mode <mode>` as a detached background process (nohup + setsid + & —
#      setsid puts the QA wrapper in its OWN process group so a stop command
#      can kill the whole tree, issue #20).
#   3. Writes the QA session PID to <worktree>/.qa.pid and, when setsid is
#      available, the process-group id to <worktree>/.qa.pgid (written from
#      INSIDE the wrapper, so it is always the real group leader).
#   4. Redirects stdout+stderr to <worktree>/qa.log.
#   5. On harness exit, writes the exit code to <worktree>/.qa.exit and creates
#      the completion marker directory <worktree>/.qa.done/ (same atomic mkdir
#      convention as run-worker.sh's .harness.done).
#
# QA is verification-only: the harness runs the session in read+command mode
# (no write_to_file), so the QA agent can boot the app and run tests via
# execute_command but cannot modify source files.
#
# Env overrides:
#   HEADLESSCODE_CLI   command that runs the harness CLI (default
#                      "npx tsx src/cli.ts", resolved from this repo root)
#   HEADLESSCODE_ROOT  repo root containing src/cli.ts (default: this repo)
#   HEADLESSCODE_MAX_COST_USD / HEADLESSCODE_MAX_DURATION_MS
#                      Phase 6 per-session budget; when set, forwarded to the
#                      CLI as --max-cost-usd / --max-duration-ms
#   HEADLESSCODE_PRICING_JSON  forwarded to the CLI (inherited env)
#
# Usage:
#   scripts/run-qa.sh <worktree-path> [--mode <slug>] [--model <id>]
#
# Prints the QA session PID on stdout (the only stdout output).

set -euo pipefail

usage() {
    echo "Usage: $0 <worktree-path> [--mode <slug>] [--model <id>] [--log-file <path>]" >&2
    exit 2
}

if [ "$#" -lt 1 ]; then
    usage
fi

WT_PATH="$1"
shift

MODE="qa-agent"
MODEL=""
LOG_FILE=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --mode)
            MODE="${2:-qa-agent}"
            shift 2
            ;;
        --mode=*)
            MODE="${1#--mode=}"
            shift
            ;;
        --model)
            MODEL="${2:-}"
            shift 2
            ;;
        --model=*)
            MODEL="${1#--model=}"
            shift
            ;;
        --log-file)
            LOG_FILE="${2:-}"
            shift 2
            ;;
        --log-file=*)
            LOG_FILE="${1#--log-file=}"
            shift
            ;;
        *)
            echo "run-qa: unknown argument: $1" >&2
            usage
            ;;
    esac
done

# ── Resolve the harness root + CLI ──────────────────────────────────────────
HARNESS_ROOT="${HEADLESSCODE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CLI="${HEADLESSCODE_CLI:-npx tsx src/cli.ts}"

if [ ! -f "$HARNESS_ROOT/src/cli.ts" ]; then
    echo "run-qa: HEADLESSCODE_ROOT ($HARNESS_ROOT) has no src/cli.ts — point it at the headlesscode repo" >&2
    exit 2
fi

if [ -z "$WT_PATH" ] || [ ! -d "$WT_PATH" ]; then
    echo "run-qa: worktree path does not exist: $WT_PATH" >&2
    exit 2
fi

# ── Write the QA checklist task file ────────────────────────────────────────
# The mode's own checklist (qa-agent customInstructions + .roo/rules-qa-agent/)
# is spliced into the system prompt automatically when the repo defines the
# mode; this task file is the thin task-side pointer plus the generic checklist
# wording for repos without a qa-agent mode.
TASK_FILE="$WT_PATH/.qa-task.md"
cat > "$TASK_FILE" <<'EOF'
Run the QA checklist defined in your operating instructions against this
workspace. Boot the application, run the relevant test suite, exercise the
changed behavior, and report EVIDENCE with real command output.

When you are done, call attempt_completion with a structured summary:
- A verdict line: QA PASS (all checks clean) or QA FAIL (any error, failed
  test, or behavior that does not work).
- An Evidence section listing each command you ran and its real output.
- The final baseline numbers you personally confirmed.

You are verification-only: do NOT modify source files. If something fails,
report it.
EOF

# ── Build the wrapper that runs the CLI and records completion ─────────────
# Same pattern as run-worker.sh: the wrapper runs in its own `bash -c`
# (deliberately WITHOUT `set -e` so markers are always written).
MODEL_ARG=""
if [ -n "$MODEL" ]; then
    MODEL_ARG="--model '$MODEL'"
fi
LOG_FILE_ARG=""
if [ -n "$LOG_FILE" ]; then
    LOG_FILE_ARG="--log-file '$LOG_FILE'"
fi

# Phase 6: forward the per-session budget env vars as CLI flags.
BUDGET_ARG=""
if [ -n "${HEADLESSCODE_MAX_COST_USD:-}" ]; then
    BUDGET_ARG="$BUDGET_ARG --max-cost-usd '$HEADLESSCODE_MAX_COST_USD'"
fi
if [ -n "${HEADLESSCODE_MAX_DURATION_MS:-}" ]; then
    BUDGET_ARG="$BUDGET_ARG --max-duration-ms '$HEADLESSCODE_MAX_DURATION_MS'"
fi

WRAPPER="
cd '$HARNESS_ROOT'
$CLI --task-file '$TASK_FILE' --workspace '$WT_PATH' --mode '$MODE' $MODEL_ARG $LOG_FILE_ARG $BUDGET_ARG
CODE=\$?
printf '%s' \"\$CODE\" > '$WT_PATH/.qa.exit'
mkdir '$WT_PATH/.qa.done' 2>/dev/null
exit \$CODE
"

# ── Launch detached + record pid + pgid ─────────────────────────────────────
rm -f "$WT_PATH/.qa.exit"
rm -rf "$WT_PATH/.qa.done"

# Issue #20 (same fix as run-worker.sh): run the QA wrapper in its OWN process
# group via setsid so a stop command can kill the whole tree, and record the
# group id from INSIDE the wrapper (exact even when setsid has to fork).
SETSID_OK=0
if command -v setsid >/dev/null 2>&1; then
    SETSID_OK=1
    WRAPPER="printf '%s' \"\$\$\" > '$WT_PATH/.qa.pgid'
$WRAPPER"
else
    echo "run-qa: warning: setsid not found — QA session will share the caller's process group; stopping it can only kill the wrapper PID (issue #20)" >&2
fi

if [ "$SETSID_OK" -eq 1 ]; then
    nohup setsid bash -c "$WRAPPER" >"$WT_PATH/qa.log" 2>&1 &
else
    nohup bash -c "$WRAPPER" >"$WT_PATH/qa.log" 2>&1 &
fi
PID=$!
printf '%s' "$PID" > "$WT_PATH/.qa.pid"

printf '%s' "$PID"
