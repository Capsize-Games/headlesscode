#!/usr/bin/env bash
# codemap-watch.sh — run the deterministic per-project codemap in WATCH mode.
#
# Long-running poll loop: regenerates the codemap (codemap.json / codemap.lock
# / codemap.html in the central per-project store) whenever the repo's source
# files change, then sleeps. Fingerprint-aware: an unchanged repo writes
# nothing, so this is cheap enough to run forever.
#
# This is the script a cron job or systemd service should invoke for a given
# project. One-shot regeneration (what a systemd *timer* should call, since
# timers already handle the "every N minutes" part) is just:
#
#   HEADLESSCODE_ROOT=<repo> scripts/codemap-watch.sh --once /path/to/project
#
# Usage:
#   scripts/codemap-watch.sh [--once] [--interval-ms <n>] <workspace-path>
#
# Env overrides:
#   HEADLESSCODE_ROOT    repo containing src/cli.ts (default: this repo).
#                        Honored only when that checkout actually has the
#                        codemap subcommand — otherwise this script falls back
#                        to its own checkout (the harness exports
#                        HEADLESSCODE_ROOT to every worker pointing at the
#                        main checkout, which can be on a branch that
#                        predates the codemap subcommand).
#   HEADLESSCODE_CLI     command that runs the harness CLI. Default is the
#                        direct tsx binary (node_modules/.bin/tsx src/cli.ts)
#                        — NOT "npx tsx src/cli.ts", because npx is an extra
#                        shim that swallows SIGINT/SIGTERM instead of
#                        forwarding them, which breaks the clean-stop promise
#                        of --watch mode (systemd sends SIGTERM to the
#                        wrapper). Same choice install-cli.sh makes.
#
# Exit codes: 0 on a successful one-shot / clean stop; 2 on usage errors.

set -euo pipefail

usage() {
    echo "Usage: $0 [--once] [--interval-ms <n>] <workspace-path>" >&2
    exit 2
}

ONCE=0
INTERVAL_MS=""
WS_PATH=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --once)
            ONCE=1
            shift
            ;;
        --interval-ms)
            INTERVAL_MS="${2:-}"
            if [ -z "$INTERVAL_MS" ]; then
                usage
            fi
            shift 2
            ;;
        --interval-ms=*)
            INTERVAL_MS="${1#--interval-ms=}"
            shift
            ;;
        -h|--help)
            usage
            ;;
        -*)
            echo "codemap-watch: unknown argument: $1" >&2
            usage
            ;;
        *)
            if [ -n "$WS_PATH" ]; then
                echo "codemap-watch: expected exactly one workspace path" >&2
                usage
            fi
            WS_PATH="$1"
            shift
            ;;
    esac
done

if [ -z "$WS_PATH" ]; then
    echo "codemap-watch: missing workspace path" >&2
    usage
fi
if [ ! -d "$WS_PATH" ]; then
    echo "codemap-watch: workspace path does not exist: $WS_PATH" >&2
    exit 2
fi

CLI="${HEADLESSCODE_CLI:-node_modules/.bin/tsx src/cli.ts}"

# Resolve this script's own checkout first (robustly — `cd` to the script's
# dir before pwd -P, so a relative invocation path or a symlinked scripts/
# dir can't point us at the wrong root), then decide the harness root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

# True when the repo's cli.ts dispatches the codemap subcommand (the stable
# `if (argv[0] === "codemap")` idiom every subcommand follows in src/cli.ts).
has_codemap_subcommand() {
    grep -qE 'argv\[0\] === "codemap"' "$1/src/cli.ts"
}

HARNESS_ROOT="$SCRIPT_ROOT"
if [ -n "${HEADLESSCODE_ROOT:-}" ]; then
    if [ -f "$HEADLESSCODE_ROOT/src/cli.ts" ] && has_codemap_subcommand "$HEADLESSCODE_ROOT"; then
        HARNESS_ROOT="$(cd "$HEADLESSCODE_ROOT" && pwd -P)"
    elif has_codemap_subcommand "$SCRIPT_ROOT"; then
        echo "codemap-watch: HEADLESSCODE_ROOT ($HEADLESSCODE_ROOT) lacks the codemap subcommand; using this checkout ($SCRIPT_ROOT)" >&2
    else
        echo "codemap-watch: HEADLESSCODE_ROOT ($HEADLESSCODE_ROOT) has no src/cli.ts with a codemap subcommand" >&2
        exit 2
    fi
fi

if [ ! -f "$HARNESS_ROOT/src/cli.ts" ]; then
    echo "codemap-watch: $HARNESS_ROOT has no src/cli.ts — point HEADLESSCODE_ROOT at the headlesscode repo" >&2
    exit 2
fi

INTERVAL_ARG=""
if [ -n "$INTERVAL_MS" ]; then
    INTERVAL_ARG="--interval-ms $INTERVAL_MS"
fi
WATCH_ARG=""
if [ "$ONCE" -eq 0 ]; then
    WATCH_ARG="--watch"
fi

cd "$HARNESS_ROOT"
# shellcheck disable=SC2086
exec $CLI codemap --workspace "$WS_PATH" $WATCH_ARG $INTERVAL_ARG
