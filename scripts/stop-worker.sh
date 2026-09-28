#!/usr/bin/env bash
# stop-worker.sh — stop ONE worktree's harness/QA worker tree(s), COMPLETELY.
#
# Issue #20: `kill <wrapper-pid>` only reaps the bash wrapper
# scripts/run-worker.sh launched — the actual child (npx / node / tsx,
# reparented to init once the spawner shell exits) keeps running to
# completion, undetected, costing real money for zero benefit. This script
# targets each worker's process GROUP instead:
#
#   1. Reads the group id from <worktree>/.harness.pgid (and, for a QA
#      session, <worktree>/.qa.pgid). run-worker.sh / run-qa.sh write these
#      from INSIDE the wrapper under `setsid`, so the recorded id IS the
#      session+process-group leader — exact even when setsid had to fork.
#   2. Sends SIGTERM to the WHOLE group (`kill -TERM -- -<pgid>`), so the
#      wrapper, npx, node/tsx and every non-detached grandchild get it.
#   3. Polls up to --grace-ms for the group to die; escalates to SIGKILL.
#   4. Verifies the group is gone and reports what happened.
#
# Workers launched before the setsid change have no .pgid file — the script
# then falls back to killing the recorded wrapper PID (the OLD, incomplete
# behavior) with an explicit warning, because a negative-PID signal would be
# unsafe when the wrapper is not actually a process-group leader.
#
# Usage:
#   scripts/stop-worker.sh <worktree-path> [--grace-ms <n>]
#
# Exit codes:
#   0  every worker tree found was confirmed gone (killed, or already gone)
#   1  a worker tree could not be confirmed gone (missing pid file, or it
#      survived SIGKILL — a human must investigate)
#   2  usage error (bad or missing arguments)

set -uo pipefail

usage() {
    echo "Usage: $0 <worktree-path> [--grace-ms <n>]" >&2
    exit 2
}

if [ "$#" -lt 1 ]; then
    usage
fi

WT_PATH="$1"
shift

GRACE_MS=5000
while [ "$#" -gt 0 ]; do
    case "$1" in
        --grace-ms)
            GRACE_MS="${2:-5000}"
            shift 2
            ;;
        --grace-ms=*)
            GRACE_MS="${1#--grace-ms=}"
            shift
            ;;
        *)
            echo "stop-worker: unknown argument: $1" >&2
            usage
            ;;
    esac
done

case "$GRACE_MS" in
    ''|*[!0-9]*)
        echo "stop-worker: --grace-ms must be a non-negative integer (got '$GRACE_MS')" >&2
        exit 2
        ;;
esac

if [ ! -d "$WT_PATH" ]; then
    echo "stop-worker: worktree path does not exist: $WT_PATH" >&2
    exit 2
fi

SANDBOX_MARKER="$WT_PATH/.harness.openshell-sandbox"
stop_openshell_sandbox() {
    [ -f "$SANDBOX_MARKER" ] || return 0
    SANDBOX_NAME="$(tr -d '[:space:]' < "$SANDBOX_MARKER")"
    if ! [[ "$SANDBOX_NAME" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
        echo "stop-worker: invalid OpenShell sandbox name in $SANDBOX_MARKER" >&2
        exit 1
    fi
    if ! command -v openshell >/dev/null 2>&1; then
        echo "stop-worker: openshell CLI is required to stop sandbox $SANDBOX_NAME" >&2
        exit 1
    fi
    DELETE_OUTPUT="$(openshell sandbox delete "$SANDBOX_NAME" 2>&1)" || {
        if ! [[ "$DELETE_OUTPUT" =~ [Nn]ot\ found|does\ not\ exist ]]; then
            echo "stop-worker: failed to delete OpenShell sandbox $SANDBOX_NAME: $DELETE_OUTPUT" >&2
            exit 1
        fi
    }
    DEADLINE=$((SECONDS + 30))
    while :; do
        LIST_OUTPUT="$(openshell sandbox list --output json 2>&1)" || {
            echo "stop-worker: could not verify OpenShell sandbox deletion: $LIST_OUTPUT" >&2
            exit 1
        }
        SANDBOX_LIST="$LIST_OUTPUT" SANDBOX_NAME="$SANDBOX_NAME" node -e '
            let x;
            try { x = JSON.parse(process.env.SANDBOX_LIST); } catch { process.exit(2); }
            const a = Array.isArray(x) ? x : (x && Array.isArray(x.sandboxes) ? x.sandboxes : null);
            if (!a || a.some(s => !s || typeof s.name !== "string")) process.exit(2);
            process.exit(a.some(s => s.name === process.env.SANDBOX_NAME) ? 0 : 1);
        ' 2>/dev/null
        LIST_STATUS=$?
        if [ "$LIST_STATUS" -eq 1 ]; then
            echo "stop-worker: OpenShell sandbox $SANDBOX_NAME confirmed deleted"
            OPENSHELL_SANDBOX_NAME="$SANDBOX_NAME" node -e '
                const fs = require("node:fs");
                const os = require("node:os");
                const path = require("node:path");
                const name = process.env.OPENSHELL_SANDBOX_NAME;
                if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) process.exit(2);
                const root = path.resolve(process.env.HEADLESSCODE_OPENSHELL_SCRATCH_ROOT || path.join(os.homedir(), ".local", "share", "headlesscode", "openshell-sessions"));
                fs.rmSync(path.join(root, `headlesscode-openshell-session-${name}`), { recursive: true, force: true });
                fs.rmSync(path.join(root, `headlesscode-openshell-session-${name}.lock`), { recursive: true, force: true });
            ' || {
                echo "stop-worker: failed to clean OpenShell scratch workspace for $SANDBOX_NAME" >&2
                exit 1
            }
            return 0
        fi
        if [ "$LIST_STATUS" -ne 0 ]; then
            echo "stop-worker: OpenShell sandbox list returned malformed JSON; cannot verify deletion" >&2
            exit 1
        fi
        if [ "$SECONDS" -ge "$DEADLINE" ]; then
            echo "stop-worker: OpenShell sandbox $SANDBOX_NAME remains after delete" >&2
            exit 1
        fi
        sleep 0.25
    done
}

# Delete first to stop remote execution promptly, then verify deletion again
# after killing the launcher to close the create/stop race.
stop_openshell_sandbox || exit 1

# Kill ONE process tree identified by its pid/pgid marker files.
# $1 = label ("harness"|"qa"), $2 = worktree path.
# Returns 0 when the tree is confirmed gone, 1 when it is not.
stop_tree() {
    local label="$1"
    local wt="$2"
    local pgid_file="$wt/.$label.pgid"
    local pid_file="$wt/.$label.pid"
    local target=""
    local grouped=0

    if [ -f "$pgid_file" ]; then
        target="$(cat "$pgid_file" 2>/dev/null | tr -d '[:space:]' || true)"
        grouped=1
    elif [ -f "$pid_file" ]; then
        target="$(cat "$pid_file" 2>/dev/null | tr -d '[:space:]' || true)"
    fi

    if [ -z "$target" ] || ! [[ "$target" =~ ^[0-9]+$ ]]; then
        echo "stop-worker: no $label worker recorded for $wt (no valid .$label.pgid/.$label.pid) — nothing to stop"
        return 0
    fi

    # A negative pid targets the whole process group. Only safe when the
    # recorded id is actually a group leader (setsid path, .pgid file).
    local sig_target="$target"
    if [ "$grouped" -eq 1 ]; then
        sig_target="-$target"
    else
        echo "stop-worker: WARNING: $label worker in $wt has no .$label.pgid (launched before the setsid change) — killing only the wrapper PID $target; descendants may survive" >&2
    fi

    if ! kill -0 -- "$sig_target" 2>/dev/null; then
        echo "stop-worker: $label worker ($([ "$grouped" -eq 1 ] && echo "group ")$target) of $wt already gone"
        return 0
    fi

    echo "stop-worker: sending SIGTERM to $label worker $([ "$grouped" -eq 1 ] && echo "process group ")$target of $wt"
    kill -TERM -- "$sig_target" 2>/dev/null || true

    # Poll for the tree to die (100ms ticks), then escalate to SIGKILL.
    local max_tries=$((GRACE_MS / 100))
    if [ "$max_tries" -lt 1 ]; then
        max_tries=1
    fi
    local tries=0
    while kill -0 -- "$sig_target" 2>/dev/null; do
        if [ "$tries" -ge "$max_tries" ]; then
            break
        fi
        sleep 0.1
        tries=$((tries + 1))
    done

    if kill -0 -- "$sig_target" 2>/dev/null; then
        echo "stop-worker: $label worker $target still alive after ${GRACE_MS}ms — escalating to SIGKILL"
        kill -KILL -- "$sig_target" 2>/dev/null || true
        sleep 0.5
        if kill -0 -- "$sig_target" 2>/dev/null; then
            echo "stop-worker: ERROR: $label worker group $target survived SIGKILL — a human must investigate" >&2
            return 1
        fi
    fi

    echo "stop-worker: $label worker ($([ "$grouped" -eq 1 ] && echo "group ")$target) of $wt confirmed gone"
    return 0
}

RC=0
stop_tree harness "$WT_PATH" || RC=1
stop_tree qa "$WT_PATH" || RC=1
stop_openshell_sandbox || RC=1
if [ "$RC" -eq 0 ] && [ -f "$SANDBOX_MARKER" ]; then
    rm -f "$SANDBOX_MARKER"
fi
exit "$RC"
