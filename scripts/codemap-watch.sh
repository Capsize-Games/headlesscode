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
#   HEADLESSCODE_ROOT    repo containing src/cli.ts (default: this repo)
#   HEADLESSCODE_CLI     command that runs the harness CLI
#                        (default "npx tsx src/cli.ts")
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

HARNESS_ROOT="${HEADLESSCODE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CLI="${HEADLESSCODE_CLI:-npx tsx src/cli.ts}"

if [ ! -f "$HARNESS_ROOT/src/cli.ts" ]; then
    echo "codemap-watch: HEADLESSCODE_ROOT ($HARNESS_ROOT) has no src/cli.ts — point it at the headlesscode repo" >&2
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
