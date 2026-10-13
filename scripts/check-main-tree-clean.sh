#!/usr/bin/env bash
# check-main-tree-clean.sh — issue #136 Part B tripwire.
#
# A worker MUST write only inside its own worktree. Part A (the
# execute_command confinement gate) blocks relative-climb writes for the
# builtin executor, but the harness cannot prove a negative for every
# provider and every bypass (sudo/ssh/xargs -exec, guessed absolute
# paths, ...). This script is the backstop: run-worker.sh / run-qa.sh
# snapshot the MAIN checkout's git status before the worker starts and
# diff it right after the worker exits. Anything NEW in main — outside
# the orchestrator's own dirs — means the worker wrote outside its
# worktree. The finding is recorded in a marker file the orchestrator
# surfaces (watch.ts / reconcileGroups persist it as `main_tree_dirty`)
# and echoed loudly to stderr: the wrapper redirects stderr into
# harness.log/qa.log, while stdout stays clean for PID capture.
#
# Usage: check-main-tree-clean.sh <worker|qa> <snapshot|check> <wt-path>
# Always exits 0: tripwire infra must never fail (or pass) a worker run.
#
# Exclusions (orchestrator-owned; churn mid-run in multi-group rounds):
#   .worktrees/            other groups' worktrees + .orchestrator-state.json
#   plans/parallel-tasks/  task/rework/continuation files for other groups
# Documented blind spot: a worker escaping INTO those two dirs evades
# this tripwire. plans/issues/* and everything else is covered.
# Concurrent operator edits to main during the run window also trip the
# wire — the marker is evidence for a human/reviewer, NOT an auto-fail.
set -u -o pipefail

# All diagnostics go to stderr, never stdout: run-worker.sh prints the
# wrapper PID on stdout (a contract stdout-capturing callers and tests
# rely on), and the wrapper redirects stderr into harness.log/qa.log
# anyway, so stderr stays loud in exactly the right place.
exec >&2

ROLE="${1:?usage: check-main-tree-clean.sh <worker|qa> <snapshot|check> <wt-path>}"
MODE="${2:?usage: check-main-tree-clean.sh <worker|qa> <snapshot|check> <wt-path>}"
WT_PATH="${3:?usage: check-main-tree-clean.sh <worker|qa> <snapshot|check> <wt-path>}"

case "$ROLE" in
	worker) STEM=".harness" ;;
	qa) STEM=".qa" ;;
	*) echo "TRIPWIRE-SKIPPED: bad role '$ROLE'" ; exit 0 ;;
esac
case "$MODE" in
	snapshot | check) ;;
	*) echo "TRIPWIRE-SKIPPED: bad mode '$MODE'" ; exit 0 ;;
esac

BEFORE="$WT_PATH/$STEM.main-tree-before"
MARKER="$WT_PATH/$STEM.main-tree-dirty"

# The MAIN checkout is the common git dir's parent. Fail open with a
# loud warning when git metadata is unusable — never fail the worker.
COMMON="$(git -C "$WT_PATH" rev-parse --git-common-dir 2>/dev/null)" || {
	echo "TRIPWIRE-SKIPPED: cannot resolve main checkout from '$WT_PATH'"
	exit 0
}
case "$COMMON" in
	/*) MAIN_DIR="$COMMON" ;;
	*) MAIN_DIR="$WT_PATH/$COMMON" ;;
esac
WT_REAL="$(cd "$WT_PATH" 2>/dev/null && pwd)" || {
	echo "TRIPWIRE-SKIPPED: worktree '$WT_PATH' unreadable"
	exit 0
}
MAIN_REAL="$(cd "$MAIN_DIR/.." 2>/dev/null && pwd)" || {
	echo "TRIPWIRE-SKIPPED: main checkout under '$MAIN_DIR' unreadable"
	exit 0
}
if [ "$WT_REAL" = "$MAIN_REAL" ]; then
	echo "TRIPWIRE-SKIPPED: worker running directly on main checkout '$MAIN_REAL' — confinement by review only"
	exit 0
fi

# One porcelain snapshot of main, minus orchestrator-owned dirs. Rename
# entries (`R  old -> new`) match on the NEW path too.
snapshot_status() {
	git -C "$MAIN_REAL" status --porcelain -uall 2>/dev/null | awk '
		{
			line = $0; sub(/^.{3}/, "", line); p = line
			i = index(line, " -> ")
			if (i > 0) p = substr(line, i + 4)
			if (index(p, ".worktrees/") == 1) next
			if (index(p, "plans/parallel-tasks/") == 1) next
			print
		}
	'
}

if [ "$MODE" = "snapshot" ]; then
	TMP="$BEFORE.tmp.$$"
	if snapshot_status >"$TMP"; then
		mv "$TMP" "$BEFORE"
	else
		rm -f "$TMP"
		echo "TRIPWIRE-SKIPPED: cannot snapshot main checkout '$MAIN_REAL'"
	fi
	exit 0
fi

AFTER="$(snapshot_status)" || {
	echo "TRIPWIRE-SKIPPED: cannot re-read main checkout '$MAIN_REAL'"
	exit 0
}
if [ -f "$BEFORE" ]; then
	BEFORE_LINES="$(cat "$BEFORE")"
else
	echo "TRIPWIRE: no baseline snapshot for '$WT_PATH' — treating all main-checkout dirt as new"
	BEFORE_LINES=""
fi
NEW="$(comm -13 <(printf '%s\n' "$BEFORE_LINES" | sort) <(printf '%s\n' "$AFTER" | sort) | grep . || true)"
if [ -z "$NEW" ]; then
	rm -f "$MARKER"
	exit 0
fi
printf '%s\n' "$NEW" >"$MARKER"
COUNT="$(printf '%s\n' "$NEW" | wc -l | tr -d ' ')"
WORD="entries"
[ "$COUNT" = "1" ] && WORD="entry"
echo "MAIN-TREE-DIRTY: worker '$WT_PATH' left $COUNT new $WORD in main checkout '$MAIN_REAL':"
printf '%s\n' "$NEW" | sed 's/^/MAIN-TREE-DIRTY:   /'
echo "MAIN-TREE-DIRTY: marker: $MARKER (window between snapshot and worker exit; concurrent operator edits also match)"
exit 0
