#!/usr/bin/env bash
# spawn-parallel-worktrees.sh — spin up N isolated git worktrees, each with
# its own Docker stack (unique ports + COMPOSE_PROJECT_NAME) and its own
# HEADLESS harness worker (a background process), replacing the previous
# script's "open a VS Code window + xdotool-inject the task" step.
#
# CLI contract — IDENTICAL to the script it replaces:
#   scripts/spawn-parallel-worktrees.sh <name1>:<offset1>:<task-file1> \
#       [<name2>:<offset2>:<task-file2> ...]
#   - Zero args -> usage to stderr, exit 1.
#   - Missing task file (relative to the target repo root) -> exit 1.
#   - Existing worktree path -> skipped (idempotent; re-running is safe).
#   - Repo root via `git rev-parse --show-toplevel` (or $TARGET_REPO).
#   - Worktrees live at <root>/.worktrees/<name> on branch issues/<name>-<date>
#     created off origin/master.
#   - Per-worktree .env: copy of the main repo's .env plus
#     COMPOSE_PROJECT_NAME=headlesscode-<name>, POSTGRES_PORT=$((5433+offset)),
#     AIRUNNER_HTTP_PORT=$((8090+offset*10)), VITE_PORT=$((5174+offset)).
#   - Task file copied verbatim to <worktree>/ORCHESTRATOR_TASK.md.
#   - The codebase-search index + mode-models.json/permissions.json are NOT
#     seeded anymore: they live in the CENTRAL per-project data store
#     (~/.local/share/headlesscode/projects/<key>/ — see src/project-store.ts),
#     keyed by the repo's git-common-dir, so every worktree resolves the SAME
#     store with zero per-directory setup. The no-index guardrail below checks
#     that central location (not <repo>/.headlesscode/).
#   - Stdout is the progress log.
#
# What replaced the GUI block (lines ~144-162: `code "$wt_path"`,
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
#   HEADLESSCODE_MAX_ITERATIONS  per-session iteration cap for EVERY worker;
#                        forwarded explicitly to run-worker.sh as
#                        --max-iterations (mirrors how ORCHESTRATOR_MODE is
#                        passed explicitly). The orchestrator's --max-iterations
#                        sets this in the spawn env.
#   SPAWN_MODEL          explicit model override for EVERY worker (like an
#                        --model flag: beats the central store's
#                        mode-models.json entries; default: unset, each
#                        worker's mode resolves its own model from the CENTRAL
#                        project store's mode-models.json
#                        (~/.local/share/headlesscode/projects/<key>/ — see
#                        src/project-store.ts) via src/config/mode-models.ts,
#                        falling back to $OPENROUTER_MODEL which then flows
#                        to run-worker.sh)
#   PLAN_FIRST           when set (e.g. PLAN_FIRST=1), run a SHORT
#                        architect-mode planning session in each worktree
#                        BEFORE launching its code worker (issue #49). The
#                        planner reads ORCHESTRATOR_TASK.md + the assigned
#                        issues, explores, and writes PLAN.md at the worktree
#                        root; the plan is then APPENDED into
#                        ORCHESTRATOR_TASK.md under an "Implementation plan"
#                        section so the code worker executes against it. The
#                        planner task file comes from
#                        plans/parallel-tasks/<name>-plan.md when present
#                        (the orchestrator writes it for --plan-first rounds),
#                        else a generic fallback prompt is used. OPT-IN — never
#                        the default. NOTE: the plan session runs SYNCHRONOUSLY
#                        (foreground), so N plan-first worktrees extend the
#                        spawn call by ~N × plan-session time.
#   PLAN_FIRST_MODE      mode slug for the plan-first session (default:
#                        architect; anything the worker CLI accepts — built-in
#                        or .roomodes)
#   PLAN_FIRST_MAX_ITERATIONS  iteration cap for the plan-first session
#                        (default: 15 — deliberately short: the plan session
#                        must produce a plan, not implement it)
#   ALLOW_UNINDEXED      when set (e.g. ALLOW_UNINDEXED=1), a missing
#                        codebase-search index in the central store is only a
#                        warning and worktrees spawn unindexed. When UNSET
#                        (default) a missing index is a HARD failure: the
#                        whole spawn aborts before creating any worktree.
#   HEADLESSCODE_AUTO_INDEX  when set (e.g. HEADLESSCODE_AUTO_INDEX=1), a
#                        missing index is built FIRST via
#                        `headlesscode index --workspace <repo>` (it lands in
#                        the central store, shared by every worktree). Costs
#                        real cloud-embedding money, so it is strictly opt-in
#                        — never automatic, never silent. Takes precedence
#                        over the ALLOW_UNINDEXED failure.
#
# Requires: node >= 18 (used only to merge the state JSON + resolve the
# per-mode model — the harness is a node project, so this is not a new
# dependency), git, bash.

set -euo pipefail

HARNESS_ROOT="${HEADLESSCODE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# The CLI command the plan-first session (run_plan_first) runs in the
# foreground — same default as run-worker.sh's own (npx tsx src/cli.ts,
# resolved from the harness root). Defined at TOP level: run-worker.sh defines
# its own copy for the worker, but this one must exist for the spawner itself.
CLI="${HEADLESSCODE_CLI:-npx tsx src/cli.ts}"

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

# ── No-index guardrail ────────────────────────────────────────────────────────
# The codebase-search index lives in the CENTRAL per-project data store
# (~/.local/share/headlesscode/projects/<key>/codesearch/index.jsonl — see
# src/project-store.ts), keyed by the repo's git-common-dir so every worktree
# shares it with zero seeding. Without this check a spawn would start every
# worker at "not indexed" with no way to know — blind read_file/grep walks,
# the exact slowness this round fixes. Default: hard-fail the whole spawn
# BEFORE creating any worktree. Escapes (see header):
#   ALLOW_UNINDEXED=1          keep the historical warning-and-continue
#   HEADLESSCODE_AUTO_INDEX=1  build the index first (opt-in; costs real
#                              cloud-embedding money via `headlesscode index`)
# Resolve the central index path via the REAL TypeScript logic
# (src/index-util.ts, indexFilePathFor) — never a bash reimplementation.
central_index_file() {
    (
        cd "$HARNESS_ROOT"
        npx tsx -e '
            import { indexFilePathFor } from "./src/index-util.ts"
            process.stdout.write(indexFilePathFor(process.argv[1]))
        ' "$REPO_ROOT"
    )
}
INDEX_FILE="$(central_index_file)"
if [ ! -f "$INDEX_FILE" ] || [ ! -s "$INDEX_FILE" ]; then
    if [ -n "${HEADLESSCODE_AUTO_INDEX:-}" ]; then
        echo "No codebase-search index in the central store — building it now (HEADLESSCODE_AUTO_INDEX=1):"
        echo "  headlesscode index --workspace $REPO_ROOT"
        CLI="${HEADLESSCODE_CLI:-npx tsx src/cli.ts}"
        (cd "$HARNESS_ROOT" && $CLI index --workspace "$REPO_ROOT")
    elif [ -z "${ALLOW_UNINDEXED:-}" ]; then
        echo "No codebase-search index found. Run 'headlesscode index --workspace $REPO_ROOT' first, or set ALLOW_UNINDEXED=1 to proceed without it." >&2
        exit 1
    fi
fi

WORKTREE_PARENT="$REPO_ROOT/.worktrees"
DATE_TAG="$(date +%Y-%m-%d)"
STATE_FILE="$WORKTREE_PARENT/.orchestrator-state.json"
ORCH_MODE="${ORCHESTRATOR_MODE:-code}"

# Issue #49 plan-first experiment: OPT-IN, off unless PLAN_FIRST is set. The
# orchestrator sets these via buildSpawnEnv when --plan-first is passed; a
# standalone spawner invocation can set them directly.
PLAN_FIRST="${PLAN_FIRST:-}"
PLAN_FIRST_MODE="${PLAN_FIRST_MODE:-architect}"
PLAN_FIRST_MAX_ITERATIONS="${PLAN_FIRST_MAX_ITERATIONS:-15}"

mkdir -p "$WORKTREE_PARENT"

# ── State-file merge (node one-liner; the harness is a node project) ────────
# Merges a JSON patch ({ groups: [...] }) into the state file, upserting by
# group name. Keeps the file valid JSON even when it doesn't exist yet.
#
# mode (3rd arg, default "merge"):
#   - "merge":   shallow-merge the patch onto any existing same-named entry
#                (used for in-round follow-up patches, e.g. spawned -> running,
#                where preserving other fields written moments ago is correct).
#   - "replace": REPLACE any existing same-named entry wholesale instead of
#                merging. Required for the FIRST patch of a new round: a
#                worktree slot (e.g. "w1") is commonly reused after
#                `orchestrate cleanup` removes the old worktree dir but
#                leaves the group's state entry in place for history. A
#                shallow merge there would let the PREVIOUS round's
#                review_verdict/qa/cost_recorded/reviewed_at survive into the
#                new round untouched — cli.ts's review/QA gates check those
#                fields for `!== undefined`, so stale non-undefined values
#                make a brand-new round look already-reviewed/QA'd/costed,
#                silently skipping real verification. (Caught live 2026-08-05:
#                issue #25's own round inherited issue #5's stale QA evidence
#                this exact way.)
merge_state() {
    local state_file="$1"
    local patch_file="$2"
    local mode="${3:-merge}"
    node -e '
        const fs = require("fs")
        const path = require("path")
        const [stateFile, patchFile, mode] = process.argv.slice(1)
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
            if (i >= 0) state.groups[i] = mode === "replace" ? g : { ...state.groups[i], ...g }
            else state.groups.push(g)
        }
        state.updated = new Date().toISOString()
        fs.mkdirSync(path.dirname(stateFile), { recursive: true })
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n")
    ' "$state_file" "$patch_file" "$mode"
}

# ── Per-mode model resolution ────────────────────────────────────────────────
# Resolve the OpenRouter model id for a worktree's harness mode via the REAL
# TypeScript logic (src/config/mode-models.ts, resolveModelForMode) — never a
# bash reimplementation. Precedence (documented in mode-models.ts): an
# explicit SPAWN_MODEL override -> the CENTRAL project store's
# mode-models.json[mode] -> ...["_default"] -> $OPENROUTER_MODEL -> empty (the
# CLI's own default).
#
# The config lives in the central store keyed by $REPO_ROOT's git-common-dir
# (src/project-store.ts) — resolved from $REPO_ROOT, and every worktree of the
# repo resolves the same store automatically, so there is NO per-worktree
# seeding to do here anymore.
#
# Prints the resolved model id on stdout (possibly empty); exits non-zero on
# any error so a broken mode-models.json fails loudly instead of silently
# spawning workers with the wrong model (mode-models.ts's own fail-loudly rule).
resolve_mode_model() {
    local mode="$1"
    local workspace_root="$2"
    local model_override="${SPAWN_MODEL:-}"
    # cd into the harness root so tsx resolves the RELATIVE import
    # ./src/config/mode-models.ts against the harness repo, not against the
    # caller's cwd (which may be the target repo or anywhere else).
    (
        cd "$HARNESS_ROOT"
        npx tsx -e '
            import { resolveModelForMode } from "./src/config/mode-models.ts"
            const [workspaceRoot, mode, explicitModel] = process.argv.slice(1)
            const resolved = resolveModelForMode({
                workspaceRoot,
                mode,
                explicitModel: explicitModel === "" ? undefined : explicitModel,
            })
            if (resolved !== undefined) process.stdout.write(resolved)
        ' "$workspace_root" "$mode" "$model_override"
    )
}

# Extract issue numbers from a task file basename following the
# <name>-issue<numbers>.md convention (e.g. issue27 -> 27, issue29-36 -> 29 36).
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

# Resolve a worktree branch name that is free BOTH locally and on origin
# (issue #15). The intended issues/<name>-<date> name can collide with a
# leftover branch from an earlier round: locally (a previous worktree branch
# that was never deleted) or on origin (a previous push/PR that was never
# cleaned up). Without disambiguation the spawn either dies (`git worktree add
# -b` refuses an existing branch) or — worse — succeeds locally while origin
# already owns the name, so the worker's push fails and it improvises a silent
# rename that nobody can see. Resolving the name HERE keeps the worktree's
# local branch equal to the branch that will be pushed, and lets the spawner
# record the REAL final name in group.branch in the orchestrator state.
#
# Local check: `git rev-parse --verify refs/heads/<candidate>`. Remote check:
# `git ls-remote --exit-code` against origin (the live remote — authoritative;
# a network failure is treated as "no collision", matching the script's
# best-effort `git fetch` below). Appends -2, -3, ... until a name is free on
# both.
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

# ── Plan-first phase (issue #49) ─────────────────────────────────────────────
# Run a SHORT architect-mode planning session inside a freshly-created worktree
# BEFORE its code worker launches. The planner reads ORCHESTRATOR_TASK.md + the
# assigned issues, explores, and writes PLAN.md at the worktree root; on
# success the plan is APPENDED into ORCHESTRATOR_TASK.md under an
# "Implementation plan" section so the code worker executes against it.
#
# This is deliberately NOT run-worker.sh (which launches a DETACHED background
# worker and writes .harness.pid/.harness.done markers): the plan phase must
# complete BEFORE the worker starts, and its markers must never be mistaken
# for the worker's by the orchestrator watcher. It runs the CLI FOREGROUND
# with no markers; output appends to the worktree's harness.log under its own
# separator so the run history stays in one place.
#
# Sets the GLOBAL $PLAN_PHASE_STATUS to "ok" (plan produced + appended) or
# "failed" (session errored / wrote no PLAN.md) — the caller reads it AFTER
# the call (NOT via command substitution: the function's stdout is the spawner's
# progress log, and capturing it would inject newlines into the caller's JSON
# state patch). A failed plan phase is a WARNING + fallback, never a spawn
# abort: the code worker runs without a plan (the historical behavior) and the
# state records plan_first.status=failed so the experiment's data still shows
# the plan phase happened.
run_plan_first() {
    local wt_path="$1"
    local name="$2"
    PLAN_PHASE_STATUS="failed"

    local planner_task="$REPO_ROOT/plans/parallel-tasks/${name}-plan.md"
    if [ -f "$planner_task" ]; then
        cp "$planner_task" "$wt_path/ORCHESTRATOR_PLAN.md"
    else
        # Standalone spawner invocation without the orchestrator: fall back to
        # a generic planner prompt (the planner derives context from the
        # ORCHESTRATOR_TASK.md always copied into the worktree above).
        cat > "$wt_path/ORCHESTRATOR_PLAN.md" <<'EOF'
Project and mode-specific rules (from the central shared store and this project's own .roo/rules*) are already spliced into your system prompt automatically — you do not need to read any rules file yourself.

You are the PLANNING phase of an autonomous two-phase workflow. Your ONLY job is to produce a compact, actionable implementation plan for the code session that follows.

1. Read `ORCHESTRATOR_TASK.md` at the workspace root — it is the FULL task the code session must execute.
2. Explore the codebase just enough to ground the plan (grep/read the files the task touches).
3. Write the plan to `PLAN.md` at the workspace root (OVERWRITE any existing PLAN.md): goal, concrete steps (files + functions), verification steps, and risks. Make every step something another session can act on without re-doing your exploration.
4. Finish with attempt_completion summarizing where the plan was written.

Constraints: DO NOT implement anything (no source edits, no commits, no pushes). DO NOT ask the human questions — you are headless. DO NOT use switch_mode. Keep the plan SHORT.
EOF
    fi

    local planner_model
    planner_model="$(resolve_mode_model "$PLAN_FIRST_MODE" "$REPO_ROOT")"
    echo "  Plan-first phase for '$name' (mode $PLAN_FIRST_MODE, max $PLAN_FIRST_MAX_ITERATIONS iterations, model: ${planner_model:-<unset — CLI default>})..."
    local planner_args=(--task-file "$wt_path/ORCHESTRATOR_PLAN.md" --workspace "$wt_path" --mode "$PLAN_FIRST_MODE")
    if [ -n "$planner_model" ]; then
        planner_args+=(--model "$planner_model")
    fi
    planner_args+=(--max-iterations "$PLAN_FIRST_MAX_ITERATIONS")

    printf '\n===== plan-first run start: %s (mode %s, max-iterations %s) =====\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PLAN_FIRST_MODE" "$PLAN_FIRST_MAX_ITERATIONS" >>"$wt_path/harness.log"
    local plan_ok=1
    (cd "$HARNESS_ROOT" && $CLI "${planner_args[@]}") >>"$wt_path/harness.log" 2>&1 || plan_ok=0

    if [ "$plan_ok" -eq 1 ] && [ -s "$wt_path/PLAN.md" ]; then
        {
            echo ""
            echo "## Implementation plan (from the plan-first phase)"
            echo ""
            cat "$wt_path/PLAN.md"
        } >> "$wt_path/ORCHESTRATOR_TASK.md"
        echo "  Plan-first: PLAN.md produced; appended to ORCHESTRATOR_TASK.md for the code worker"
        PLAN_PHASE_STATUS="ok"
    elif [ "$plan_ok" -eq 1 ]; then
        echo "  WARNING: plan-first session for '$name' exited 0 but wrote no PLAN.md — code worker runs without a plan" >&2
        PLAN_PHASE_STATUS="failed"
    else
        echo "  WARNING: plan-first session for '$name' FAILED — code worker runs without a plan (fallback, issue #49)" >&2
        PLAN_PHASE_STATUS="failed"
    fi
}

# ── Spawn loop ───────────────────────────────────────────────────────────────
for spec in "$@"; do
    name="$(printf '%s' "$spec" | cut -d: -f1)"
    offset="$(printf '%s' "$spec" | cut -d: -f2)"
    task_file="$(printf '%s' "$spec" | cut -d: -f3-)"
    wt_path="$WORKTREE_PARENT/$name"

    if [ -z "$name" ] || [ -z "$offset" ]; then
        echo "spawn-parallel-worktrees: malformed spec '$spec' (expected <name>:<offset>:<task-file>)" >&2
        exit 1
    fi

    if [ -n "$task_file" ] && [ ! -f "$REPO_ROOT/$task_file" ]; then
        echo "ERROR: task file '$task_file' not found relative to $REPO_ROOT" >&2
        exit 1
    fi

    if [ -d "$wt_path" ]; then
        echo "ERROR: $name — $wt_path already exists. Remove it first (git worktree remove ...) then retry." >&2
        exit 1
    fi

    intended_branch="issues/${name}-${DATE_TAG}"
    branch="$(resolve_worktree_branch "$intended_branch")"
    if [ "$branch" != "$intended_branch" ]; then
        echo "  NOTE (issue #15): branch '$intended_branch' already exists (local or on origin) — using disambiguated branch '$branch' instead. group.branch in the orchestrator state records the REAL name."
    fi

    echo "=== Creating worktree '$name' at $wt_path (branch $branch, port offset $offset) ==="

    # Base-branch resolution (round1-consolidation 2026-08-16: hardcoding
    # origin/master silently branched every worktree off the WRONG lineage when
    # the fetch failed and the repo's primary branch is not master — this repo
    # works off pyside6-desktop). Resolution order: $HEADLESSCODE_BASE_BRANCH
    # override → origin's default branch → the main checkout's current branch.
    # A fetch failure falls back to the SAME-NAMED local branch (correct lineage
    # offline) rather than a hardcoded master. Unresolvable base = hard failure:
    # a wrong-lineage round is worse than no round.
    base_branch="${HEADLESSCODE_BASE_BRANCH:-}"
    if [ -z "$base_branch" ]; then
        # `|| true`: with set -euo pipefail a missing ref would abort the script.
        base_branch="$(git -C "$REPO_ROOT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)"
    fi
    if [ -z "$base_branch" ]; then
        base_branch="$(git -C "$REPO_ROOT" symbolic-ref --short HEAD 2>/dev/null || true)"
    fi
    if [ -z "$base_branch" ]; then
        echo "ERROR: $name — cannot resolve a base branch (set HEADLESSCODE_BASE_BRANCH or check out the repo's primary branch). Refusing to guess." >&2
        exit 1
    fi

    echo "  (base branch: $base_branch)"
    git -C "$REPO_ROOT" fetch origin "$base_branch" --quiet 2>/dev/null || echo "  (note: git fetch origin $base_branch failed — will use local '$base_branch' if it exists)"
    if ! git -C "$REPO_ROOT" worktree add -b "$branch" "$wt_path" "origin/$base_branch"; then
        echo "  (origin/$base_branch unavailable — falling back to local $base_branch)"
        if ! git -C "$REPO_ROOT" worktree add -b "$branch" "$wt_path" "$base_branch"; then
            echo "ERROR: $name — could not create worktree on branch '$branch' from base '$base_branch' (neither origin/$base_branch nor local $base_branch resolvable). Remove the leftover and retry." >&2
            exit 1
        fi
    fi

    # zoo-code/ (the upstream reference clone used as a vendoring source,
    # see ATTRIBUTION.md) is gitignored, so `git worktree add` never
    # copies it in. Symlink it from the main checkout so a worker in this
    # worktree can still read upstream source at the pinned commit.
    if [ -d "$REPO_ROOT/zoo-code" ] && [ ! -e "$wt_path/zoo-code" ]; then
        ln -s ../../zoo-code "$wt_path/zoo-code"
    fi

    # No index / mode-models / permissions seeding here anymore: all of that
    # state lives in the CENTRAL per-project data store
    # (~/.local/share/headlesscode/projects/<key>/ — see src/project-store.ts),
    # keyed by the repo's git-common-dir. This worktree (and every other one)
    # resolves that same store automatically — copying would be redundant and
    # the manual per-worktree seeding this block existed for is gone.

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
        echo "COMPOSE_PROJECT_NAME=headlesscode-${name}"
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
    # "replace": this is the FIRST patch for this group name in this round —
    # wholesale-replace rather than merge, so a reused worktree slot never
    # inherits a previous round's review_verdict/qa/cost_recorded/etc. (see
    # merge_state's doc comment).
    merge_state "$STATE_FILE" "$patch_file" replace
    rm -f "$patch_file"

    # ── Plan-first phase (issue #49): a SHORT architect-mode session BEFORE ──
    # the code worker. OPT-IN via PLAN_FIRST; the plan is appended into
    # ORCHESTRATOR_TASK.md so the worker executes against it. Synchronous
    # (foreground) — see run_plan_first's doc comment. plan_status flows into
    # the "running" state patch below.
    plan_status="skipped"
    if [ -n "$PLAN_FIRST" ]; then
        # NOT a command substitution: run_plan_first's stdout is the spawner's
        # progress log and the status comes back via the $PLAN_PHASE_STATUS
        # global (capturing stdout would inject the echo lines' newlines into
        # the JSON state patch below).
        run_plan_first "$wt_path" "$name"
        plan_status="$PLAN_PHASE_STATUS"
    fi

    # ── Launch the headless worker (replaces code + sleep 20 + xdotool) ─────
    # Resolve the worker's model FIRST so mode-models.json affects the very
    # first spawn, not just rework re-spawns. Passing the resolved value
    # explicitly (--model) keeps run-worker.sh's CLI free of any env var the
    # worktree may or may not inherit, and an empty resolution adds no flag at
    # all (the worker CLI then applies its own default).
    echo "  Launching headless harness worker for '$name' (mode $ORCH_MODE)..."
    WORKER_MODEL="$(resolve_mode_model "$ORCH_MODE" "$REPO_ROOT")"
    MODEL_ARGS=()
    if [ -n "$WORKER_MODEL" ]; then
        MODEL_ARGS=(--model "$WORKER_MODEL")
    fi
    MAX_ITER_ARGS=()
    if [ -n "${HEADLESSCODE_MAX_ITERATIONS:-}" ]; then
        MAX_ITER_ARGS=(--max-iterations "$HEADLESSCODE_MAX_ITERATIONS")
    fi
    WORKER_PID="$(ORCHESTRATOR_MODE="$ORCH_MODE" bash "$HARNESS_ROOT/scripts/run-worker.sh" \
        "$wt_path" "ORCHESTRATOR_TASK.md" --mode "$ORCH_MODE" "${MODEL_ARGS[@]}" "${MAX_ITER_ARGS[@]}")"
    echo "  Worker pid: $WORKER_PID (model: ${WORKER_MODEL:-<unset — CLI default>}, log: $wt_path/harness.log)"

    # ── Record "running" now that the worker is up ──────────────────────────
    # plan_first is only recorded when the plan-first phase was actually
    # requested (PLAN_FIRST set); a plain round never gets the field.
    PLAN_FIRST_PATCH=""
    if [ -n "$PLAN_FIRST" ]; then
        if [ "$plan_status" = "ok" ]; then
            PLAN_FIRST_PATCH="      \"plan_first\": { \"mode\": \"$PLAN_FIRST_MODE\", \"status\": \"ok\", \"report\": \"PLAN.md\" },"
        else
            PLAN_FIRST_PATCH="      \"plan_first\": { \"mode\": \"$PLAN_FIRST_MODE\", \"status\": \"$plan_status\" },"
        fi
    fi
    patch_file="$(mktemp)"
    cat > "$patch_file" <<EOF
{
  "groups": [
    {
      "name": "$name",
      "status": "running",
$PLAN_FIRST_PATCH
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
