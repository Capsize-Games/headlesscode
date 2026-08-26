#!/usr/bin/env bash
# headlesscode-answer.sh — unblock a worker that escalated a decision via
# ask_followup_question (see src/tools/executor.ts). A worker blocked on a
# question writes <worktree>/.harness.needs-decision and polls for
# <worktree>/.harness.decision-answer; this script writes that answer file.
# The worker (or the orchestrator's watch loop, see src/orchestrator/watch.ts)
# picks it up on its next poll, deletes both marker files, and resumes with
# the answer text as a normal tool result.
#
# Usage:
#   scripts/headlesscode-answer.sh <worktree-path> "<answer text>"
#
# Prints nothing on success; the worker resumes within its poll interval
# (default ~5s).

set -euo pipefail

usage() {
    echo "Usage: $0 <worktree-path> \"<answer text>\"" >&2
    exit 2
}

if [ "$#" -ne 2 ]; then
    usage
fi

WT_PATH="$1"
ANSWER="$2"

if [ -z "$WT_PATH" ] || [ ! -d "$WT_PATH" ]; then
    echo "headlesscode-answer: worktree path does not exist: $WT_PATH" >&2
    exit 2
fi

if [ -z "$ANSWER" ]; then
    echo "headlesscode-answer: answer text must not be empty" >&2
    exit 2
fi

if [ ! -f "$WT_PATH/.harness.needs-decision" ]; then
    echo "headlesscode-answer: warning: $WT_PATH/.harness.needs-decision not found — the worker may not be blocked (answering anyway)" >&2
fi

printf '%s' "$ANSWER" > "$WT_PATH/.harness.decision-answer"
