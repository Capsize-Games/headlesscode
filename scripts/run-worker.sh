#!/usr/bin/env bash
# run-worker.sh — launch ONE headless harness worker as a background process
# for a worktree, replacing the xdotool/wmctrl GUI-injection step of
# scripts/inject-task-into-window.sh (airunner). This is the headless
# counterpart of "open a VS Code window, paste the task, press Enter".
#
# Worker lifecycle:
#   1. Runs `$HEADLESSCODE_CLI --task-file <task> --workspace <worktree>
#      --mode <mode>` (or `--task <text>` when given text) as a detached
#      background process (nohup + & — no GUI, no X server needed).
#   2. Writes the worker PID to <worktree>/.harness.pid.
#   3. Redirects stdout+stderr to <worktree>/harness.log.
#   4. On harness exit, writes the exit code to <worktree>/.harness.exit and
#      creates the completion marker directory <worktree>/.harness.done/
#      (`mkdir` is atomic, so this is the same lock-mutex convention the
#      airunner phone-home.sh uses for its lock dir — the orchestrator's
#      completion poll keys off this marker instead of an xdotool wake-up).
#
# Env overrides:
#   HEADLESSCODE_CLI   command that runs the harness CLI (default
#                      "npx tsx src/cli.ts", resolved from this repo root)
#   HEADLESSCODE_ROOT  repo root containing src/cli.ts (default: this repo)
#   HEADLESSCODE_MEMORY_DIR  when set, forwarded to the CLI as --memory-dir
#                      (Phase 3 memory; enables recall+recording for the worker)
#   HEADLESSCODE_PROJECT  forwarded to the CLI as the session project scope
#   HEADLESSCODE_MAX_COST_USD / HEADLESSCODE_MAX_DURATION_MS
#                      Phase 6 per-session budget; when set, forwarded to the
#                      CLI as --max-cost-usd / --max-duration-ms (a budgeted
#                      worker aborts with reason "budget" instead of running
#                      away on cost/time)
#   HEADLESSCODE_PRICING_JSON  forwarded to the CLI (pricing table override;
#                      inherited through the environment automatically)
#   HEADLESSCODE_DECISION_TIMEOUT_MS  decision-escalation timeout, ms; when
#                      set, forwarded to the CLI as --decision-timeout-ms
#                      (ask_followup_question blocks this long waiting for
#                      .harness.decision-answer before falling back to
#                      autonomous decision; default 30 min). Answer a blocked
#                      worker with scripts/headlesscode-answer.sh.
#
# Usage:
#   scripts/run-worker.sh <worktree-path> <task-file-or-text> \
#       [--mode <slug>] [--model <id>] [--log-file <path>]
#
# Prints the worker PID on stdout (the only stdout output).

set -euo pipefail

usage() {
    echo "Usage: $0 <worktree-path> <task-file-or-text> [--mode <slug>] [--model <id>] [--log-file <path>]" >&2
    exit 2
}

if [ "$#" -lt 2 ]; then
    usage
fi

WT_PATH="$1"
shift
TASK="$1"
shift

MODE="code"
MODEL=""
LOG_FILE=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --mode)
            MODE="${2:-code}"
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
            echo "run-worker: unknown argument: $1" >&2
            usage
            ;;
    esac
done

# ── Resolve the harness root + CLI ──────────────────────────────────────────
HARNESS_ROOT="${HEADLESSCODE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CLI="${HEADLESSCODE_CLI:-npx tsx src/cli.ts}"

if [ ! -f "$HARNESS_ROOT/src/cli.ts" ]; then
    echo "run-worker: HEADLESSCODE_ROOT ($HARNESS_ROOT) has no src/cli.ts — point it at the headlesscode repo" >&2
    exit 2
fi

if [ -z "$WT_PATH" ] || [ ! -d "$WT_PATH" ]; then
    echo "run-worker: worktree path does not exist: $WT_PATH" >&2
    exit 2
fi

# ── Task: file vs inline text ───────────────────────────────────────────────
# Resolution order for a task that looks like a file: absolute path, then
# relative to the worktree, then relative to the harness repo.
TASK_FLAG=""
TASK_PATH=""
if [ -f "$TASK" ]; then
    TASK_FLAG="--task-file"
    TASK_PATH="$TASK"
elif [ -f "$WT_PATH/$TASK" ]; then
    TASK_FLAG="--task-file"
    TASK_PATH="$WT_PATH/$TASK"
elif [ -f "$HARNESS_ROOT/$TASK" ]; then
    TASK_FLAG="--task-file"
    TASK_PATH="$HARNESS_ROOT/$TASK"
else
    TASK_FLAG="--task"
    TASK_PATH="$TASK"
fi

if [ "$TASK_FLAG" = "--task-file" ] && [ ! -s "$TASK_PATH" ]; then
    echo "run-worker: task file is empty or unreadable: $TASK_PATH" >&2
    exit 2
fi

# ── Build the wrapper that runs the CLI and records completion ─────────────
# The wrapper runs in its own `bash -c` (deliberately WITHOUT `set -e` so the
# completion markers are always written, even when the CLI fails). It:
#   - cd's into the harness root (HEADLESSCODE_CLI resolves from there),
#   - runs the CLI with the resolved task flag + workspace + mode,
#   - records the exit code and creates the .harness.done marker dir.
# Env is inherited, so OPENROUTER_* flows through unchanged.
MODEL_ARG=""
if [ -n "$MODEL" ]; then
    MODEL_ARG="--model '$MODEL'"
fi
LOG_FILE_ARG=""
if [ -n "$LOG_FILE" ]; then
    LOG_FILE_ARG="--log-file '$LOG_FILE'"
fi
MEMORY_DIR_ARG=""
if [ -n "${HEADLESSCODE_MEMORY_DIR:-}" ]; then
    MEMORY_DIR_ARG="--memory-dir '$HEADLESSCODE_MEMORY_DIR'"
fi

# Phase 6: forward the per-session budget env vars as CLI flags (the CLI also
# reads them from env, but forwarding makes the budget visible in harness.log).
BUDGET_ARG=""
if [ -n "${HEADLESSCODE_MAX_COST_USD:-}" ]; then
    BUDGET_ARG="$BUDGET_ARG --max-cost-usd '$HEADLESSCODE_MAX_COST_USD'"
fi
if [ -n "${HEADLESSCODE_MAX_DURATION_MS:-}" ]; then
    BUDGET_ARG="$BUDGET_ARG --max-duration-ms '$HEADLESSCODE_MAX_DURATION_MS'"
fi

# Decision escalation: forward the env var as a CLI flag too (visible in
# harness.log), same rationale as the budget args above.
if [ -n "${HEADLESSCODE_DECISION_TIMEOUT_MS:-}" ]; then
    BUDGET_ARG="$BUDGET_ARG --decision-timeout-ms '$HEADLESSCODE_DECISION_TIMEOUT_MS'"
fi

WRAPPER="
cd '$HARNESS_ROOT'
$CLI $TASK_FLAG '$TASK_PATH' --workspace '$WT_PATH' --mode '$MODE' $MODEL_ARG $LOG_FILE_ARG $MEMORY_DIR_ARG $BUDGET_ARG
CODE=\$?
printf '%s' \"\$CODE\" > '$WT_PATH/.harness.exit'
mkdir '$WT_PATH/.harness.done' 2>/dev/null
exit \$CODE
"

# ── Launch detached + record pid ────────────────────────────────────────────
rm -f "$WT_PATH/.harness.exit"
rm -rf "$WT_PATH/.harness.done"
nohup bash -c "$WRAPPER" >"$WT_PATH/harness.log" 2>&1 &
PID=$!
printf '%s' "$PID" > "$WT_PATH/.harness.pid"

printf '%s' "$PID"
