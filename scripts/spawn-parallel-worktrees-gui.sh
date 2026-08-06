#!/usr/bin/env bash
# Spin up N isolated git worktrees, each with its own VS Code window, so
# multiple Zoo Code agents can work on separate task files simultaneously.
#
# This is the GUI/xdotool sibling of this repo's own headless spawner
# (scripts/spawn-parallel-worktrees.sh, which launches detached background
# harness processes instead of VS Code windows). Ported from a sister
# project's script of the same purpose, adapted for this repo: no Docker
# stack, no per-worktree port shifting — headlesscode has neither.
#
# Worktrees live INSIDE the repo, under .worktrees/ (gitignored), not as a
# sibling directory outside it — a sibling directory sits outside the main
# window's workspace root, and Zoo Code's file-edit/read tools gate on
# workspace root even in full-auto mode, prompting for manual approval on
# every file operation against it.
#
# This script is designed to be run BY Zoo Code itself (via its shell
# tool) from the main repo window — running a shell command has no
# workspace-root restriction the way the file-edit tools do.
#
# Usage:
#   scripts/spawn-parallel-worktrees-gui.sh <name1>:<offset1>:<task-file1> [...]
#
# Example (4 agents):
#   scripts/spawn-parallel-worktrees-gui.sh \
#     execwait:0:plans/execute-command-background-semantics.md \
#     perms:1:plans/permissions-parity.md \
#     diffedit:2:plans/diff-based-editing.md \
#     rework:3:plans/rework-loop.md
#
# Each worktree is created at .worktrees/<name> (gitignored), on a new
# branch issues/<name>-<date>, with:
#   - its own .env (copied verbatim from the main repo's — no port
#     overrides, there's nothing here that needs them)
#   - ORCHESTRATOR_TASK.md at the worktree root, containing the real
#     content of <task-fileN>
#   - the main repo's codebase-search index (if any) copied in, so
#     codebase_search works in the fresh worktree (the index is gitignored
#     and `git worktree add` never brings it)
#   - a VS Code window opened at that path, with its task injected and
#     submitted automatically via scripts/inject-task-into-window.sh
#     (xdotool-driven UI automation — clipboard-paste + keystroke, the
#     same input path a human uses)
#
# The `offset` field is kept in the CLI contract for consistency with the
# headless spawner's spec format even though nothing here currently uses
# it for port math — harmless, ignore it.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_PARENT="$REPO_ROOT/.worktrees"
DATE_TAG="$(date +%Y-%m-%d)"

mkdir -p "$WORKTREE_PARENT"

if [ "$#" -eq 0 ]; then
    echo "Usage: $0 <name1>:<offset1>:<task-file1> [<name2>:<offset2>:<task-file2> ...]" >&2
    echo "Example: $0 w1:0:plans/w1.md w2:1:plans/w2.md" >&2
    exit 1
fi

# Resolve a worktree branch name that is free BOTH locally and on origin
# (issue #15) — see the headless spawner's resolve_worktree_branch for the
# full rationale. The intended issues/<name>-<date> name can collide with a
# leftover branch from an earlier round; the worker must never end up on a
# local branch whose name differs from what it can push.
resolve_worktree_branch() {
    local base="$1"
    local candidate="$base"
    local n=2
    while git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/heads/$candidate" >/dev/null 2>&1 ||
          git -C "$REPO_ROOT" ls-remote --exit-code origin "refs/heads/$candidate" >/dev/null 2>&1; do
        candidate="${base}-${n}"
        n=$((n + 1))
    done
    printf '%s' "$candidate"
}

for spec in "$@"; do
    name="$(echo "$spec" | cut -d: -f1)"
    offset="$(echo "$spec" | cut -d: -f2)"
    task_file="$(echo "$spec" | cut -d: -f3-)"
    wt_path="$WORKTREE_PARENT/$name"

    if [ -n "$task_file" ] && [ ! -f "$REPO_ROOT/$task_file" ]; then
        echo "ERROR: task file '$task_file' not found relative to $REPO_ROOT" >&2
        exit 1
    fi

    if [ -d "$wt_path" ]; then
        echo "Skipping $name — $wt_path already exists."
        continue
    fi

    intended_branch="issues/${name}-${DATE_TAG}"
    branch="$(resolve_worktree_branch "$intended_branch")"
    if [ "$branch" != "$intended_branch" ]; then
        echo "  NOTE (issue #15): branch '$intended_branch' already exists (local or on origin) — using disambiguated branch '$branch' instead."
    fi

    echo "=== Creating worktree '$name' at $wt_path (branch $branch) ==="

    git -C "$REPO_ROOT" fetch origin master --quiet 2>/dev/null || echo "  (note: git fetch origin master failed — using local master)"
    if ! git -C "$REPO_ROOT" worktree add -b "$branch" "$wt_path" origin/master; then
        echo "  (origin/master unavailable — falling back to local master)"
        if ! git -C "$REPO_ROOT" worktree add -b "$branch" "$wt_path" master; then
            echo "ERROR: $name — could not create worktree on branch '$branch' (it may already exist; see the collision note above). Remove the leftover and retry." >&2
            exit 1
        fi
    fi

    if [ -f "$REPO_ROOT/.env" ]; then
        cp "$REPO_ROOT/.env" "$wt_path/.env"
    fi

    # zoo-code/ (the upstream reference clone used as a vendoring source,
    # see ATTRIBUTION.md) is gitignored, so `git worktree add` never
    # copies it in. Symlink it from the main checkout so a worker in this
    # worktree can still read upstream source at the pinned commit.
    if [ -d "$REPO_ROOT/zoo-code" ] && [ ! -e "$wt_path/zoo-code" ]; then
        ln -s ../../zoo-code "$wt_path/zoo-code"
    fi

    # No codebase-search index seeding here anymore: the index lives in the
    # CENTRAL per-project data store
    # (~/.local/share/headlesscode/projects/<key>/ — see src/project-store.ts),
    # keyed by the repo's git-common-dir. This worktree (and every other one)
    # resolves that same store automatically, so there is nothing to copy.

    if [ -n "$task_file" ]; then
        cp "$REPO_ROOT/$task_file" "$wt_path/ORCHESTRATOR_TASK.md"
    else
        echo "# No task file provided for $name — fill in manually." \
            > "$wt_path/ORCHESTRATOR_TASK.md"
    fi

    echo "Worktree '$name' ready: $wt_path"
    echo "  Opening VS Code window..."
    code "$wt_path" || echo "  (could not launch 'code' automatically — open $wt_path manually)"

    # Fixed wait, not a readiness poll — there's no reliable external
    # signal for "Zoo Code is ready to accept input" short of the
    # webview's own DOM state. 20s has been sufficient in practice on
    # this machine; increase if injection lands before the window has
    # finished loading.
    echo "  Waiting 20s for VS Code + Zoo Code to load..."
    sleep 20
    if command -v xdotool >/dev/null 2>&1 && command -v wmctrl >/dev/null 2>&1; then
        echo "  Injecting and submitting task via xdotool..."
        "$REPO_ROOT/scripts/inject-task-into-window.sh" "$name" \
            "$wt_path/ORCHESTRATOR_TASK.md" --submit \
            || echo "  Injection failed — open $wt_path/ORCHESTRATOR_TASK.md and paste it in manually."
    else
        echo "  xdotool/wmctrl not available — paste $wt_path/ORCHESTRATOR_TASK.md in manually."
    fi
    echo ""
done

echo "All requested worktrees created under $WORKTREE_PARENT."
