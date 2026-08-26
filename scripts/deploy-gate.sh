#!/usr/bin/env bash
# deploy-gate.sh — human-approval deploy gate (Phase 4.2).
#
# The gate is a HARD STOP in front of a target repo's production deploy
# script (default scripts/deploy-production.sh in the target repo). It NEVER
# auto-approves and NEVER runs the deploy
# script without explicit human approval.
#
# Flow:
#   1. Validate the target repo + deploy script path (path safety: the
#      resolved script must live INSIDE the target repo root).
#   2. Print a deployment summary (what's being deployed) from a provided or
#      generated notes file / the .orchestrator-state.json batch summary.
#   3. Require approval — TWO modes:
#        interactive (stdin is a TTY):  prompt "Approve deploy? [y/N]"
#        non-interactive:                one of
#          (a) a one-time approval file created by a human, e.g.
#              touch <repo>/.worktrees/.deploy-approved-<batch>
#              (also $DEPLOY_APPROVAL_FILE), OR
#          (b) env DEPLOY_APPROVAL_TOKEN matching the token stored in
#              <repo>/.deploy-approval (also --token-file).
#      If not approved → clear message + exit 3 and NO deploy action runs.
#   4. ONLY after approval: run the repo's deploy script, passing deploy args
#      from DEPLOY_ARGS env or CLI args after `--`.
#
# The approval DECISION is computed by src/deploy/gate-cli.ts (TypeScript,
# pure + unit-tested) — this script only does UI, path safety, and invoking
# the deploy script.
#
# Usage:
#   scripts/deploy-gate.sh <target-repo> [--batch <name>] [--notes <file>] \
#       [--token-file <path>] [--approval-file <path>] [--deploy-script <rel>] \
#       [--deploy-args "<flags>"] [--] [deploy args...]
#
# Env:
#   DEPLOY_APPROVAL_TOKEN   token for non-interactive approval
#   DEPLOY_APPROVAL_FILE    one-time approval file path (default
#                           <repo>/.worktrees/.deploy-approved-<batch>)
#   DEPLOY_ARGS             deploy args forwarded to the deploy script
#   DEPLOY_SCRIPT           relative path of the deploy script inside the
#                           target repo (default scripts/deploy-production.sh)
#
# Exit codes:
#   0  approved + deploy script executed
#   2  usage / path-safety / missing deploy script error (nothing ran)
#   3  human approval DENIED (nothing ran — hard stop)

set -euo pipefail

HARNESS_ROOT="${HEADLESSCODE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

usage() {
    echo "Usage: $0 <target-repo> [--batch <name>] [--notes <file>] [--token-file <path>] [--approval-file <path>] [--deploy-script <rel>] [--deploy-args \"<flags>\"] [--] [deploy args...]" >&2
    exit 2
}

if [ "$#" -lt 1 ]; then
    usage
fi

REPO=""
BATCH="round"
NOTES=""
TOKEN_FILE=""
APPROVAL_FILE=""
DEPLOY_SCRIPT_REL="${DEPLOY_SCRIPT:-scripts/deploy-production.sh}"
DEPLOY_ARGS_STR="${DEPLOY_ARGS:-}"
EXTRA_ARGS=()

# ── Argument parsing ─────────────────────────────────────────────────────────
# while-loop + guarded shift (NOT a for-loop over "$@" + raw shift): the for
# form re-iterates the original list and the trailing `shift` on an exhausted
# positional list returns 1, which set -e turns into an exit 1.
PASSTHROUGH=0
while [ "$#" -gt 0 ]; do
    arg="$1"
    if [ "$PASSTHROUGH" = "1" ]; then
        EXTRA_ARGS+=("$arg")
        shift
        continue
    fi
    case "$arg" in
        --)
            PASSTHROUGH=1
            shift
            ;;
        --batch)
            BATCH="${2:-round}"
            [ "$#" -ge 2 ] && shift 2 || shift
            ;;
        --batch=*)
            BATCH="${arg#--batch=}"
            shift
            ;;
        --notes)
            NOTES="${2:-}"
            [ "$#" -ge 2 ] && shift 2 || shift
            ;;
        --notes=*)
            NOTES="${arg#--notes=}"
            shift
            ;;
        --token-file)
            TOKEN_FILE="${2:-}"
            [ "$#" -ge 2 ] && shift 2 || shift
            ;;
        --token-file=*)
            TOKEN_FILE="${arg#--token-file=}"
            shift
            ;;
        --approval-file)
            APPROVAL_FILE="${2:-}"
            [ "$#" -ge 2 ] && shift 2 || shift
            ;;
        --approval-file=*)
            APPROVAL_FILE="${arg#--approval-file=}"
            shift
            ;;
        --deploy-script)
            DEPLOY_SCRIPT_REL="${2:-$DEPLOY_SCRIPT_REL}"
            [ "$#" -ge 2 ] && shift 2 || shift
            ;;
        --deploy-script=*)
            DEPLOY_SCRIPT_REL="${arg#--deploy-script=}"
            shift
            ;;
        --deploy-args)
            DEPLOY_ARGS_STR="${2:-$DEPLOY_ARGS_STR}"
            [ "$#" -ge 2 ] && shift 2 || shift
            ;;
        --deploy-args=*)
            DEPLOY_ARGS_STR="${arg#--deploy-args=}"
            shift
            ;;
        -*)
            echo "deploy-gate: unknown argument: $arg" >&2
            usage
            ;;
        *)
            if [ -z "$REPO" ]; then
                REPO="$arg"
            else
                EXTRA_ARGS+=("$arg")
            fi
            shift
            ;;
    esac
done

if [ -z "$REPO" ]; then
    echo "deploy-gate: <target-repo> is required" >&2
    usage
fi

# ── 1. Path safety ───────────────────────────────────────────────────────────
REPO="$(realpath -m "$REPO")"
if [ ! -d "$REPO" ]; then
    echo "deploy-gate: target repo does not exist: $REPO" >&2
    exit 2
fi

# Resolve the deploy script inside the repo root. Both the lexical path and
# the realpath (symlinks collapsed) must stay strictly inside the repo.
SCRIPT_ABS="$(realpath -m "$REPO/$DEPLOY_SCRIPT_REL")"
if [ "$SCRIPT_ABS" != "$REPO" ] && [ "${SCRIPT_ABS#"$REPO"/}" = "$SCRIPT_ABS" ]; then
    echo "deploy-gate: deploy script path escapes the target repo root (refusing to run): $SCRIPT_ABS" >&2
    exit 2
fi
if [ ! -f "$SCRIPT_ABS" ]; then
    echo "deploy-gate: deploy script not found: $SCRIPT_ABS" >&2
    echo "  Set DEPLOY_SCRIPT (relative to the repo root) or --deploy-script to point at the real one." >&2
    exit 2
fi

# ── 2. Deployment summary + approval decision (via the TS helper) ───────────
TOKEN_FILE_ARG=""
if [ -n "$TOKEN_FILE" ]; then
    TOKEN_FILE_ARG="--token-file '$TOKEN_FILE'"
fi
APPROVAL_FILE_ARG=""
if [ -n "$APPROVAL_FILE" ]; then
    APPROVAL_FILE_ARG="--approval-file '$APPROVAL_FILE'"
elif [ -n "${DEPLOY_APPROVAL_FILE:-}" ]; then
    APPROVAL_FILE_ARG="--approval-file '$DEPLOY_APPROVAL_FILE'"
fi
NOTES_ARG=""
if [ -n "$NOTES" ]; then
    NOTES_ARG="--notes '$NOTES'"
fi

# Interactive only when stdin is a real TTY (a piped/redirected stdin is
# treated as non-interactive — token/file mode).
INTERACTIVE=0
if [ -t 0 ]; then
    INTERACTIVE=1
fi

GATE_OUT="$(mktemp /tmp/headlesscode-deploy-gate-XXXXXX.out)"
GATE_CLI="node --import tsx '$HARNESS_ROOT/src/deploy/gate-cli.ts'"

run_gate_helper() {
    # $1 = extra args (may be empty). Runs the helper, capturing exit code
    # without letting set -e abort on the helper's deliberate exit 3.
    local extra="${1:-}"
    set +e
    ( eval "cd '$HARNESS_ROOT' && $GATE_CLI --repo '$REPO' --batch '$BATCH' $NOTES_ARG $TOKEN_FILE_ARG $APPROVAL_FILE_ARG $extra" ) >"$GATE_OUT" 2>&1
    GATE_EXIT=$?
    set -e
}

if [ "$INTERACTIVE" = "1" ]; then
    # Interactive: first get the summary (approval result ignored), then prompt.
    run_gate_helper ""
    SUMMARY="$(sed -n '/^DEPLOY_SUMMARY_BEGIN$/,/^DEPLOY_SUMMARY_END$/p' "$GATE_OUT" | sed '1d;$d')"
    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo " DEPLOY GATE — production deployment summary"
    echo "════════════════════════════════════════════════════════════"
    printf '%s\n' "$SUMMARY"
    echo ""
    echo "  deploy script: $SCRIPT_ABS"
    if [ -n "$DEPLOY_ARGS_STR" ] || [ "${#EXTRA_ARGS[@]}" -gt 0 ]; then
        echo "  deploy args:   $DEPLOY_ARGS_STR ${EXTRA_ARGS[*]}"
    else
        echo "  deploy args:   (none)"
    fi
    echo "────────────────────────────────────────────────────────────"
    printf 'Approve deploy? [y/N] '
    ANSWER=""
    if ! read -r ANSWER </dev/tty; then
        ANSWER=""
    fi
    run_gate_helper "--interactive --interactive-input '$ANSWER'"
else
    # Non-interactive: token/file mode only — no prompt, no auto-approval.
    run_gate_helper ""
fi

SUMMARY="$(sed -n '/^DEPLOY_SUMMARY_BEGIN$/,/^DEPLOY_SUMMARY_END$/p' "$GATE_OUT" | sed '1d;$d')"
APPROVED="$(sed -n 's/^DEPLOY_APPROVED=//p' "$GATE_OUT" | tail -n 1)"
REASON="$(sed -n 's/^DEPLOY_REASON=//p' "$GATE_OUT" | tail -n 1)"

echo ""
echo "── Deploy gate ─────────────────────────────────────────────"
printf '%s\n' "$SUMMARY"
echo "────────────────────────────────────────────────────────────"
echo "  deploy script: $SCRIPT_ABS"
echo "  approved:      ${APPROVED:-unknown}"
echo "  reason:        ${REASON:-unknown}"
echo "────────────────────────────────────────────────────────────"

if [ "$APPROVED" != "yes" ]; then
    rm -f "$GATE_OUT"
    echo "deploy-gate: DEPLOY DENIED — production deploy NOT run (hard stop, exit 3)." >&2
    echo "deploy-gate: $REASON" >&2
    exit 3
fi

# ── 3. Approval obtained — invoke the deploy script ─────────────────────────
# Deploy args: DEPLOY_ARGS env / --deploy-args (space-separated flags, split
# intentionally — they are operator-supplied simple flags) + anything after --.
set -- $DEPLOY_ARGS_STR "${EXTRA_ARGS[@]}"
rm -f "$GATE_OUT"
echo "deploy-gate: approval confirmed — running: bash $SCRIPT_ABS $*"
(
    cd "$REPO" && bash "$SCRIPT_ABS" "$@"
)
