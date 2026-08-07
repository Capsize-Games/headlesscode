#!/usr/bin/env bash
# sync-stack-rules.sh — install the repo's shipped shared/ rules content
# (per-stack rules.md + the generic rules-code rules.md) into the
# machine-global central store.
#
# The headlesscode repo is the canonical source of the shipped central rules:
#   - shared/stacks/<stack>/rules.md — per-stack guidance, read at runtime via
#     getCentralStackRulesDir() (src/engine/stacks.ts);
#   - shared/rules-code/rules.md — generic code-mode guidance, read at runtime
#     via the vendored roo-config getGlobalRooDirectory() (which resolves to
#     ~/.local/share/headlesscode/shared — headlesscode's relocation of the
#     upstream ~/.roo, see src/vendor/zoo-code/src/services/roo-config/
#     index.ts) spliced into every code-mode system prompt by
#     addCustomInstructions() (src/vendor/zoo-code/src/core/prompts/sections/
#     custom-instructions.ts).
# The central store is the per-machine INSTALL TARGET: it is what every
# session on that machine reads. This script copies the repo's shared/ trees
# there so a checkout + install is all a machine needs.
#
# The destination MUST be the same root the runtime reads, or an install
# silently never splices. Both readers resolve the store root through
# projectStoreRoot() (src/project-store.ts), which honors $HEADLESSCODE_DATA_DIR
# (the project's standard central-store override, "a legit per-machine escape
# hatch") and defaults to the XDG convention $HOME/.local/share/headlesscode.
# This script mirrors that exactly — including absolute-izing the override the
# same way projectStoreRoot()'s path.resolve() does. Idempotent: re-running
# simply re-copies.
#
# Usage: scripts/sync-stack-rules.sh
set -euo pipefail

HARNESS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

# Each shipped tree is a directory under shared/ containing rules.md files:
# shared/stacks/<stack>/rules.md (one per stack) and shared/rules-code/rules.md.
for sub in stacks rules-code; do
	SOURCE="$HARNESS_ROOT/shared/$sub"
	[ -d "$SOURCE" ] || continue
	DEST="$DATA_DIR/shared/$sub"
	mkdir -p "$DEST"
	cp -R "$SOURCE"/. "$DEST"/
	# Echo each installed rules.md (stacks are nested one level deeper).
	for rules in "$SOURCE"/*/rules.md "$SOURCE"/rules.md; do
		[ -f "$rules" ] || continue
		rel="${rules#"$SOURCE"/}"
		echo "sync-stack-rules: installed $sub/$rel -> $DEST/$rel"
	done
done
