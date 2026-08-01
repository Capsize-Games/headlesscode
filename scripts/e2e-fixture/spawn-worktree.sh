#!/usr/bin/env bash
#
# spawn-worktree.sh — create an isolated git worktree of a repo, mirroring the
# project's ".worktrees/ per session" isolation pattern.
#
# The harness runs against the fresh worktree on its own branch, so the source
# repo (main branch + working tree) is never touched. This is exactly the
# isolation the Phase 1 acceptance criteria require: "worktree per session".
#
# Usage: scripts/e2e-fixture/spawn-worktree.sh <repo-path> <worktree-path>
#   <repo-path>      existing git repo to add a worktree of
#   <worktree-path>  directory for the worktree (created if missing; may be an
#                    existing empty directory, mirroring `mktemp -d`)
#
# Prints the worktree path on stdout (the only stdout output).

set -euo pipefail

if [ "$#" -ne 2 ]; then
	echo "usage: $0 <repo-path> <worktree-path>" >&2
	exit 2
fi

REPO="$1"
WORKTREE="$2"

if [ ! -d "$REPO/.git" ] && ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
	echo "spawn-worktree: not a git repo: $REPO" >&2
	exit 2
fi

if [ -e "$WORKTREE" ] && [ -n "$(ls -A "$WORKTREE" 2>/dev/null || true)" ]; then
	echo "spawn-worktree: worktree path exists and is not empty: $WORKTREE" >&2
	exit 2
fi

# Unique branch per session so parallel runs never collide on branch names.
BRANCH="headlesscode-e2e-$(date +%s)-$$"

mkdir -p "$(dirname "$WORKTREE")"
git -C "$REPO" worktree add -b "$BRANCH" "$WORKTREE" >&2

# The worktree path is the only thing printed to stdout.
printf '%s\n' "$WORKTREE"
