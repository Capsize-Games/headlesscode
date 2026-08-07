#!/usr/bin/env bash
# sync-shared-rules.sh — install the repo's shipped shared-rules content into
# the machine-global central store.
#
# The headlesscode repo is the canonical source of the shipped rules.md files
# ("ships with headlesscode"): per-stack rules under shared/stacks/<stack>/
# rules.md (src/engine/stacks.ts documents the central tier at
# <store>/shared/stacks/<stack>/rules.md) and per-mode rules under
# shared/rules-<mode>/rules.md (read by the vendored addCustomInstructions()
# via getGlobalRooDirectory()). The central store is the per-machine INSTALL
# TARGET: it is what every session on that machine reads via those two
# readers. This script copies the repo's shared/ tree there so a checkout +
# install is all a machine needs.
#
# The destination MUST be the same root the engine reads, or an install
# silently never splices: getCentralStackRulesDir() in src/engine/stacks.ts
# and getGlobalRooDirectory() in the vendored roo-config (the reader behind
# the `rules/` + `rules-<mode>/` splice) both resolve through
# projectStoreRoot() (src/project-store.ts), which honors $HEADLESSCODE_DATA_DIR
# (the project's standard central-store override, "a legit per-machine escape
# hatch") and defaults to the XDG convention $HOME/.local/share/headlesscode.
# This script mirrors that exactly — including absolute-izing the override the
# same way projectStoreRoot()'s path.resolve() does. Idempotent: re-running
# simply re-copies.
#
# Usage: scripts/sync-shared-rules.sh
set -euo pipefail

HARNESS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$HARNESS_ROOT/shared"
if [ -n "${HEADLESSCODE_DATA_DIR:-}" ]; then
	# Mirror projectStoreRoot()'s path.resolve() semantics: an absolute
	# override is used as-is, a relative one resolves against the script's
	# cwd — so script and engine agree on the store root.
	case "$HEADLESSCODE_DATA_DIR" in
		/*) DATA_DIR="$HEADLESSCODE_DATA_DIR" ;;
		*) DATA_DIR="$(pwd)/$HEADLESSCODE_DATA_DIR" ;;
	esac
else
	DATA_DIR="$HOME/.local/share/headlesscode"
fi
DEST="$DATA_DIR/shared"

if [ ! -d "$SOURCE" ]; then
	echo "sync-shared-rules: no $SOURCE (nothing to install)" >&2
	exit 0
fi

mkdir -p "$DEST"

# Per-stack rules: shared/stacks/<stack>/rules.md
for stack_dir in "$SOURCE"/stacks/*/; do
	[ -d "$stack_dir" ] || continue
	stack="$(basename "$stack_dir")"
	[ -f "$stack_dir/rules.md" ] || continue
	mkdir -p "$DEST/stacks/$stack"
	cp "$stack_dir/rules.md" "$DEST/stacks/$stack/rules.md"
	echo "sync-shared-rules: installed stacks/$stack -> $DEST/stacks/$stack/rules.md"
done

# Per-mode rules: shared/rules-<mode>/rules.md (e.g. rules-code)
for mode_dir in "$SOURCE"/rules-*/; do
	[ -d "$mode_dir" ] || continue
	mode="$(basename "$mode_dir")"
	[ -f "$mode_dir/rules.md" ] || continue
	mkdir -p "$DEST/$mode"
	cp "$mode_dir/rules.md" "$DEST/$mode/rules.md"
	echo "sync-shared-rules: installed $mode -> $DEST/$mode/rules.md"
done
