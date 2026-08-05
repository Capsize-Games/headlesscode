#!/usr/bin/env bash
# sync-stack-rules.sh — install the repo's shipped stack-rules content into the
# machine-global central store.
#
# The headlesscode repo is the canonical source of the per-stack rules.md files
# ("ships with headlesscode" — src/engine/stacks.ts documents the central tier
# at ~/.local/share/headlesscode/shared/stacks/<stack>/rules.md). The central
# store is the per-machine INSTALL TARGET: it is what every session on that
# machine reads via getCentralStackRulesFile(). This script copies the repo's
# shared/stacks/ tree there so a checkout + install is all a machine needs.
#
# Respects $HEADLESSCODE_DATA_DIR (the project's standard central-store
# override, see src/project-store.ts) when set; defaults to the XDG convention
# $HOME/.local/share/headlesscode. Idempotent: re-running simply re-copies.
#
# Usage: scripts/sync-stack-rules.sh
set -euo pipefail

HARNESS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$HARNESS_ROOT/shared/stacks"
if [ -n "${HEADLESSCODE_DATA_DIR:-}" ]; then
	DEST="$HEADLESSCODE_DATA_DIR/shared/stacks"
else
	DEST="$HOME/.local/share/headlesscode/shared/stacks"
fi

if [ ! -d "$SOURCE" ]; then
	echo "sync-stack-rules: no $SOURCE (nothing to install)" >&2
	exit 0
fi

mkdir -p "$DEST"
for stack_dir in "$SOURCE"/*/; do
	[ -d "$stack_dir" ] || continue
	stack="$(basename "$stack_dir")"
	[ -f "$stack_dir/rules.md" ] || continue
	mkdir -p "$DEST/$stack"
	cp "$stack_dir/rules.md" "$DEST/$stack/rules.md"
	echo "sync-stack-rules: installed $stack -> $DEST/$stack/rules.md"
done
