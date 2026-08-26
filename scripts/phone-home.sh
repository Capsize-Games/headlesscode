#!/usr/bin/env bash
# Called by a worker session when it finishes (or needs to report a
# status change) to wake the orchestrator, instead of the orchestrator
# burning cycles on a sleep-and-poll loop. Injects a short status
# message into the orchestrator's own VS Code window via the same
# xdotool mechanism used to start worker tasks in the first place —
# inject-task-into-window.sh works symmetrically in either direction.
#
# Guards against two workers finishing at the same moment and both
# injecting into the orchestrator's window at once (which could
# interleave/corrupt both messages) with a simple lock directory —
# `mkdir` is atomic, so this is a safe mutex without extra tooling.
#
# Usage:
#   scripts/phone-home.sh <orchestrator-window-title-substring> <message>
#
# Example:
#   scripts/phone-home.sh "orchestrator (Workspace)" \
#     "Worktree w1 finished: issue #27 closed, PR: https://github.com/.../pull/42"

set -euo pipefail

if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <orchestrator-window-title-substring> <message>" >&2
    exit 1
fi

ORCH_TITLE="$1"
MESSAGE="$2"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$0")/..")"
LOCK_DIR="$REPO_ROOT/.worktrees/.phone-home.lock"
MSG_FILE="$(mktemp)"
trap 'rm -f "$MSG_FILE"' EXIT

echo "$MESSAGE" > "$MSG_FILE"

# Wait up to 60s for the lock, checking every 2s. mkdir is atomic, so
# only one caller ever succeeds when several race for it.
ACQUIRED=0
for _ in $(seq 1 30); do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        ACQUIRED=1
        break
    fi
    sleep 2
done

if [ "$ACQUIRED" -ne 1 ]; then
    echo "ERROR: could not acquire phone-home lock within 60s — another" >&2
    echo "worker is likely mid-phone-home. Retry, don't skip this step:" >&2
    echo "  scripts/phone-home.sh \"$ORCH_TITLE\" \"$MESSAGE\"" >&2
    exit 1
fi
trap 'rm -rf "$LOCK_DIR"; rm -f "$MSG_FILE"' EXIT

"$REPO_ROOT/scripts/inject-task-into-window.sh" "$ORCH_TITLE" "$MSG_FILE" --submit
