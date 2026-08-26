#!/usr/bin/env bash
# run-worker.sh — launch ONE headless harness worker as a background process
# for a worktree, replacing the xdotool/wmctrl GUI-injection step of
# scripts/inject-task-into-window.sh. This is the headless
# counterpart of "open a VS Code window, paste the task, press Enter".
#
# Worker lifecycle:
#   1. Runs `$HEADLESSCODE_CLI --task-file <task> --workspace <worktree>
#      --mode <mode>` (or `--task <text>` when given text) as a detached
#      background process (nohup + setsid + & — no GUI, no X server needed).
#      setsid puts the wrapper in its OWN session/process group so a stop
#      command can kill the whole tree with one negative-PID signal (issue
#      #20: killing only the wrapper PID used to leave the real child running
#      undetected, reparented to init).
#   2. Writes the worker PID to <worktree>/.harness.pid and, when setsid is
#      available, the process-group id to <worktree>/.harness.pgid (written
#      from INSIDE the wrapper, so it is always the real group leader even if
#      setsid had to fork).
#   3. Redirects stdout+stderr to <worktree>/harness.log.
#   4. On harness exit, writes the exit code to <worktree>/.harness.exit and
#      creates the completion marker directory <worktree>/.harness.done/
#      (`mkdir` is atomic, so this is the same lock-mutex convention the
#      phone-home.sh uses for its lock dir — the orchestrator's
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
#   HEADLESSCODE_MAX_ITERATIONS  when set, forwarded to the CLI as
#                      --max-iterations (default 250, raised 2026-08-08 from
#                      50 — a multi-phase plan doc routinely needs
#                      substantial file exploration before its first edit,
#                      and 50 was hitting the cap on real rounds far more
#                      often than it should have; each iteration is cheap,
#                      roughly $0.002 with the fixed pricing/caching, so
#                      raising this further still is a cost-cheap way to
#                      avoid "max iterations reached without task
#                      completion"). An explicit --max-iterations flag below
#                      overrides it.
#   HEADLESSCODE_WINDOW_SIZE  when set, forwarded to the CLI as
#                      --window-size (default 300 messages). Rarely needs
#                      overriding now that the default accounts for
#                      deepseek/deepseek-v4-flash-0731's 1M-token context — only
#                      raise it further for a task that reads an unusually
#                      large number of files before it starts writing.
#
# Usage:
#   scripts/run-worker.sh <worktree-path> <task-file-or-text> \
#       [--mode <slug>] [--model <id>] [--log-file <path>] [--max-iterations <n>]
#
# Prints the worker PID on stdout (the only stdout output).

set -euo pipefail

usage() {
    echo "Usage: $0 <worktree-path> <task-file-or-text> [--mode <slug>] [--model <id>] [--log-file <path>] [--max-iterations <n>]" >&2
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
MAX_ITERATIONS=""

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
        --max-iterations)
            MAX_ITERATIONS="${2:-}"
            shift 2
            ;;
        --max-iterations=*)
            MAX_ITERATIONS="${1#--max-iterations=}"
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

# Iteration cap: forward as a CLI flag too, same rationale as above. An
# explicit --max-iterations flag on this script beats the env var.
MAX_ITERATIONS_VALUE="${MAX_ITERATIONS:-${HEADLESSCODE_MAX_ITERATIONS:-}}"
if [ -n "$MAX_ITERATIONS_VALUE" ]; then
    BUDGET_ARG="$BUDGET_ARG --max-iterations '$MAX_ITERATIONS_VALUE'"
fi

# Sliding-window history cap (messages, not tokens): forward as a CLI flag too.
if [ -n "${HEADLESSCODE_WINDOW_SIZE:-}" ]; then
    BUDGET_ARG="$BUDGET_ARG --window-size '$HEADLESSCODE_WINDOW_SIZE'"
fi

WRAPPER="
cd '$HARNESS_ROOT'
$CLI $TASK_FLAG '$TASK_PATH' --workspace '$WT_PATH' --mode '$MODE' $MODEL_ARG $LOG_FILE_ARG $MEMORY_DIR_ARG $BUDGET_ARG
CODE=\$?
printf '%s' \"\$CODE\" > '$WT_PATH/.harness.exit'
mkdir '$WT_PATH/.harness.done' 2>/dev/null
exit \$CODE
"

# ── Launch detached + record pid + pgid ─────────────────────────────────────
rm -f "$WT_PATH/.harness.exit"
rm -rf "$WT_PATH/.harness.done"
# A worktree is reused across continuation/rework respawns, so harness.log
# must be APPENDED to, never truncated — a worker that hits the iteration cap
# or gets a review rework cycle keeps its full log history (and the orchestrator
# keeps its accumulated spend/token stats, which live in separate per-session
# .headlesscode/usage/<sessionId>.jsonl files and were never actually cleared).
# The run-start separator lets watch.ts's tailLog() scope the "current run"
# summary/exhaustion check to only this run's output, not a stale tail from a
# previous session still sitting in the same file.
printf '\n===== headlesscode run start: %s =====\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$WT_PATH/harness.log"

# Issue #20: run the wrapper in its OWN process group so a stop command can
# kill the WHOLE tree (wrapper bash + npx + node/tsx + non-detached
# grandchildren) with a single negative-PID signal (`kill -TERM -<pgid>`).
# `kill <wrapper-pid>` alone reaps only the bash wrapper — the real child,
# reparented to init once the spawner shell exits, keeps running undetected to
# completion. `setsid` makes the wrapper a session+process-group leader; every
# descendant inherits that group unless it deliberately detaches.
# The wrapper writes its OWN PID (== PGID) to .harness.pgid from INSIDE, so
# the recorded group id is exact even in the rare case setsid has to fork
# because the caller was already a process-group leader. Without setsid
# (non-Linux), no .harness.pgid is written and a stop command falls back to
# the old wrapper-only kill with an explicit warning.
SETSID_OK=0
if command -v setsid >/dev/null 2>&1; then
    SETSID_OK=1
    WRAPPER="printf '%s' \"\$\$\" > '$WT_PATH/.harness.pgid'
$WRAPPER"
else
    echo "run-worker: warning: setsid not found — worker will share the caller's process group; stopping it can only kill the wrapper PID (issue #20)" >&2
fi

if [ "$SETSID_OK" -eq 1 ]; then
    nohup setsid bash -c "$WRAPPER" >>"$WT_PATH/harness.log" 2>&1 &
else
    nohup bash -c "$WRAPPER" >>"$WT_PATH/harness.log" 2>&1 &
fi
PID=$!
printf '%s' "$PID" > "$WT_PATH/.harness.pid"

printf '%s' "$PID"
