#!/usr/bin/env bash
# spawn-parallel-worktrees.sh — spin up N isolated git worktrees, each with
# its own Docker stack (unique ports + COMPOSE_PROJECT_NAME) and its own
# HEADLESS harness worker (a background process), replacing the airunner
# script's "open a VS Code window + xdotool-inject the task" step.
#
# CLI contract — IDENTICAL to the airunner script it replaces:
#   scripts/spawn-parallel-worktrees.sh <name1>:<offset1>:<task-file1> \
#       [<name2>:<offset2>:<task-file2> ...]
#   - Zero args -> usage to stderr, exit 1.
#   - Missing task file (relative to the target repo root) -> exit 1.
#   - Existing worktree path -> skipped (idempotent; re-running is safe).
#   - Repo root via `git rev-parse --show-toplevel` (or $TARGET_REPO).
#   - Worktrees live at <root>/.worktrees/<name> on branch issues/<name>-<date>
#     created off origin/master.
#   - Per-worktree .env: copy of the main repo's .env plus
#     COMPOSE_PROJECT_NAME=airunner-<name>, POSTGRES_PORT=$((5433+offset)),
#     AIRUNNER_HTTP_PORT=$((8090+offset*10)), VITE_PORT=$((5174+offset)).
#   - Task file copied verbatim to <worktree>/ORCHESTRATOR_TASK.md.
#   - Stdout is the progress log.
#
# What replaced the GUI block (airunner lines ~144-162: `code "$wt_path"`,
# `sleep 20`, then xdotool/wmctrl/xclip injection via
# scripts/inject-task-into-window.sh):
#   - scripts/run-worker.sh is called once per worktree: it launches the
#     headless harness CLI (`npx tsx src/cli.ts ...`) as a detached
#     background process, writes <wt>/.harness.pid, logs to <wt>/harness.log,
#     and records completion via <wt>/.harness.exit + <wt>/.harness.done/.
#   - The orchestrator state file (.worktrees/.orchestrator-state.json) is
#     written/updated with one groups[] entry per spawned worktree
#     (status spawned -> running, spawned timestamp, last_activity). The
#     watcher (src/orchestrator/watch.ts) keys off .harness.done markers.
#
# Env overrides:
#   TARGET_REPO          target repo root (default: git rev-parse from cwd)
#   ORCHESTRATOR_MODE    harness mode for workers (default: code)
#   HEADLESSCODE_CLI     harness CLI command (default: "npx tsx src/cli.ts",
#                        resolved from the headlesscode repo root)
#   HEADLESSCODE_ROOT    headlesscode repo root containing src/cli.ts
#
# Requires: node >= 18 (used only to merge the state JSON — the harness is a
# node project, so this is not a new dependency), git, bash.

set -euo pipefail

HARNESS_ROOT="${HEADLESSCODE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [ "$#" -eq 0 ]; then
    echo "Usage: $0 <name1>:<offset1>:<task-file1> [<name2>:<offset2>:<task-file2> ...]" >&2
    echo "Example: $0 w1:0:plans/parallel-tasks/w1.md w2:1:plans/parallel-tasks/w2.md" >&2
    exit 1
fi

# ── Target repo root ─────────────────────────────────────────────────────────
REPO_ROOT="${TARGET_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [ -z "$REPO_ROOT" ]; then
    echo "spawn-parallel-worktrees: cannot determine target repo root — run inside the repo or set TARGET_REPO=<path>" >&2
    exit 1
fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

WORKTREE_PARENT="$REPO_ROOT/.worktrees"
DATE_TAG="$(date +%Y-%m-%d)"
STATE_FILE="$WORKTREE_PARENT/.orchestrator-state.json"
ORCH_MODE="${ORCHESTRATOR_MODE:-code}"

mkdir -p "$WORKTREE_PARENT"

# ── State-file merge (node one-liner; the harness is a node project) ────────
# Merges a JSON patch ({ groups: [...] }) into the state file, upserting by
# group name. Keeps the file valid JSON even when it doesn't exist yet.
merge_state() {
    local state_file="$1"
    local patch_file="$2"
    node -e '
        const fs = require("fs")
        const path = require("path")
        const [stateFile, patchFile] = process.argv.slice(1)
        let patch
        try {
            patch = JSON.parse(fs.readFileSync(patchFile, "utf-8"))
        } catch (err) {
            console.error("spawn-parallel-worktrees: invalid state patch: " + err.message)
            process.exit(1)
        }
        let state = { groups: [] }
        try {
            const parsed = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed
        } catch { /* no existing state — start fresh */ }
        if (!Array.isArray(state.groups)) state.groups = []
        for (const g of patch.groups || []) {
            const i = state.groups.findIndex((x) => x && x.name === g.name)
            if (i >= 0) state.groups[i] = { ...state.groups[i], ...g }
            else state.groups.push(g)
        }
        state.updated = new Date().toISOString()
        fs.mkdirSync(path.dirname(stateFile), { recursive: true })
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n")
    ' "$state_file" "$patch_file"
}

# Extract issue numbers from a task file basename following the airunner
# convention <name>-issue<numbers>.md (e.g. issue27 -> 27, issue29-36 -> 29 36).
issue_numbers_from_task_file() {
    local base
    base="$(basename "$1")"
    local nums
    nums="$(printf '%s' "$base" | sed -n 's/.*issue\([0-9]\+\(-[0-9]\+\)*\).*/\1/p')"
    if [ -z "$nums" ]; then
        return 0
    fi
    printf '%s' "$nums" | tr '-' ' '
}

# ── Spawn loop ───────────────────────────────────────────────────────────────
for spec in "$@"; do
    name="$(printf '%s' "$spec" | cut -d: -f1)"
    offset="$(printf '%s' "$spec" | cut -d: -f2)"
    task_file="$(printf '%s' "$spec" | cut -d: -f3-)"
    wt_path="$WORKTREE_PARENT/$name"
    branch="issues/${name}-${DATE_TAG}"

    if [ -z "$name" ] || [ -z "$offset" ]; then
        echo "spawn-parallel-worktrees: malformed spec '$spec' (expected <name>:<offset>:<task-file>)" >&2
        exit 1
    fi

    if [ -n "$task_file" ] && [ ! -f "$REPO_ROOT/$task_file" ]; then
        echo "ERROR: task file '$task_file' not found relative to $REPO_ROOT" >&2
        exit 1
    fi

    if [ -d "$wt_path" ]; then
        echo "Skipping $name — $wt_path already exists."
        continue
    fi

    echo "=== Creating worktree '$name' at $wt_path (branch $branch, port offset $offset) ==="

    git -C "$REPO_ROOT" fetch origin master --quiet 2>/dev/null || echo "  (note: git fetch origin master failed — using local master)"
    if ! git -C "$REPO_ROOT" worktree add -b "$branch" "$wt_path" origin/master 2>/dev/null; then
        echo "  (origin/master unavailable — falling back to local master)"
        git -C "$REPO_ROOT" worktree add -b "$branch" "$wt_path" master
    fi

    # zoo-code/ (the upstream reference clone used as a vendoring source,
    # see ATTRIBUTION.md) is gitignored, so `git worktree add` never
    # copies it in. Symlink it from the main checkout so a worker in this
    # worktree can still read upstream source at the pinned commit.
    if [ -d "$REPO_ROOT/zoo-code" ] && [ ! -e "$wt_path/zoo-code" ]; then
        ln -s ../../zoo-code "$wt_path/zoo-code"
    fi

    # Compute unique ports for this worktree.
    # +1 base so offset=0 never collides with the main repo's own
    # already-running stack, which sits on the plain defaults
    # (5432/8080/5173).
    pg_port=$((5433 + offset))
    http_port=$((8090 + offset * 10))
    vite_port=$((5174 + offset))

    # Copy the main repo's .env (secrets/keys) and override the
    # port + project-name knobs so this stack is fully isolated.
    if [ -f "$REPO_ROOT/.env" ]; then
        cp "$REPO_ROOT/.env" "$wt_path/.env"
    else
        touch "$wt_path/.env"
    fi
    {
        echo ""
        echo "# --- isolation overrides added by spawn-parallel-worktrees.sh ---"
        echo "COMPOSE_PROJECT_NAME=airunner-${name}"
        echo "POSTGRES_PORT=${pg_port}"
        echo "AIRUNNER_HTTP_PORT=${http_port}"
        echo "VITE_PORT=${vite_port}"
    } >> "$wt_path/.env"

    if [ -n "$task_file" ]; then
        cp "$REPO_ROOT/$task_file" "$wt_path/ORCHESTRATOR_TASK.md"
    else
        echo "# No task file provided for $name — fill in manually." \
            > "$wt_path/ORCHESTRATOR_TASK.md"
    fi

    echo "Worktree '$name' ready: $wt_path"
    echo "  Postgres port: $pg_port | HTTP port: $http_port | Vite port: $vite_port"
    echo "  Bring it up with: (cd $wt_path && docker compose up -d)"

    # ── Record "spawned" in the orchestrator state before launching ─────────
    issues="$(issue_numbers_from_task_file "$task_file" 2>/dev/null || true)"
    issues_json="["
    sep=""
    for n in $issues; do
        issues_json="${issues_json}${sep}${n}"
        sep=","
    done
    issues_json="${issues_json}]"

    spawned_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    patch_file="$(mktemp)"
    cat > "$patch_file" <<EOF
{
  "groups": [
    {
      "name": "$name",
      "worktree": ".worktrees/$name",
      "branch": "$branch",
      "issues": $issues_json,
      "task_file": "$task_file",
      "status": "spawned",
      "spawned": "$spawned_ts",
      "last_activity": { "note": "worktree created; harness worker launching" }
    }
  ]
}
EOF
    merge_state "$STATE_FILE" "$patch_file"
    rm -f "$patch_file"

    # ── Launch the headless worker (replaces code + sleep 20 + xdotool) ─────
    echo "  Launching headless harness worker for '$name' (mode $ORCH_MODE)..."
    WORKER_PID="$(ORCHESTRATOR_MODE="$ORCH_MODE" bash "$HARNESS_ROOT/scripts/run-worker.sh" \
        "$wt_path" "ORCHESTRATOR_TASK.md" --mode "$ORCH_MODE")"
    echo "  Worker pid: $WORKER_PID (log: $wt_path/harness.log)"

    # ── Record "running" now that the worker is up ──────────────────────────
    patch_file="$(mktemp)"
    cat > "$patch_file" <<EOF
{
  "groups": [
    {
      "name": "$name",
      "status": "running",
      "last_activity": { "note": "harness worker launched (pid $WORKER_PID, mode $ORCH_MODE)" }
    }
  ]
}
EOF
    merge_state "$STATE_FILE" "$patch_file"
    rm -f "$patch_file"

    echo ""
done

echo "All requested worktrees created under $WORKTREE_PARENT."
echo "State file: $STATE_FILE"
echo "Each worktree has its own EMPTY database (fresh volume) — that's"
echo "intentional isolation, not a bug. Fine for refactor/test-coverage"
echo "work; don't expect the existing dev tenant data to be there."
