#!/usr/bin/env bash
# install-cli.sh — install a systemwide `headlesscode` command.
#
# Writes a small wrapper to ~/.local/bin/headlesscode that execs this
# checkout's tsx + src/cli.ts, while preserving the caller's cwd (so
# `headlesscode`'s own --repo/--workspace defaulting to process.cwd()
# still targets whatever project the user is standing in, not this repo).
# Also syncs the repo's bundled shared/ content (per-stack rules.md, etc.)
# into the central machine-global store
# (~/.local/share/headlesscode/shared/ — see src/engine/stacks.ts), so
# installed headlesscode actually ships that content.
set -euo pipefail

HARNESS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${HEADLESSCODE_BIN_DIR:-$HOME/.local/bin}"
TARGET="$INSTALL_DIR/headlesscode"

mkdir -p "$INSTALL_DIR"

cat > "$TARGET" <<EOF
#!/usr/bin/env bash
# Installed by headlesscode/scripts/install-cli.sh — do not edit by hand;
# re-run that script to update.
export TSX_TSCONFIG_PATH="$HARNESS_ROOT/tsconfig.json"
exec "$HARNESS_ROOT/node_modules/.bin/tsx" "$HARNESS_ROOT/src/cli.ts" "\$@"
EOF

chmod +x "$TARGET"

# Ship the repo's bundled shared/ content (`shared/stacks/<stack>/rules.md` +
# `shared/rules-code/rules.md`) into the runtime's central store, so shipped
# instructions actually reach worker system prompts. This resolves the SAME
# path the runtime reads: both the stacks tier (getCentralStackRulesDir() in
# src/engine/stacks.ts) and the rules-code tier (the vendored roo-config
# getGlobalRooDirectory()) are store-root-derived via projectStoreRoot()
# (src/project-store.ts), which honors $HEADLESSCODE_DATA_DIR — so the
# destination below is $HEADLESSCODE_DATA_DIR/shared/<sub> when the override
# is set, else $HOME/.local/share/headlesscode/shared/<sub>.
for sub in stacks rules-code; do
    SRC="$HARNESS_ROOT/shared/$sub"
    [ -d "$SRC" ] || continue
    DEST="${HEADLESSCODE_DATA_DIR:-$HOME/.local/share/headlesscode}/shared/$sub"
    mkdir -p "$DEST"
    cp -R "$SRC"/. "$DEST"/
    # Verify the shipped content actually landed non-empty (a silently
    # unreachable/empty install would break the "ships with headlesscode"
    # guarantee without any error).
    missing=0
    for rules in "$SRC"/*/rules.md "$SRC"/rules.md; do
        [ -f "$rules" ] || continue
        rel="${rules#"$SRC"/}"
        if [ ! -f "$DEST/$rel" ] || [ ! -s "$DEST/$rel" ]; then
            echo "error: shared content missing/empty at $DEST/$rel" >&2
            missing=1
        fi
    done
    if [ "$missing" -ne 0 ]; then
        echo "error: shared-content install verification failed (shared/$sub)" >&2
        exit 1
    fi
    echo "Installed shared/$sub -> $DEST"
done

echo "Installed headlesscode -> $TARGET (harness: $HARNESS_ROOT)"

# Install the shipped shared-rules content (shared/stacks/<stack>/rules.md +
# shared/rules-<mode>/rules.md, e.g. rules-code) into the machine-global
# central store — this is what "ships with headlesscode" means for the central
# tier (see docs/stack-rules.md). Routes through the SAME resolution the
# runtime readers use (getCentralStackRulesDir()/getGlobalRooDirectory(), both
# projectStoreRoot()/$HEADLESSCODE_DATA_DIR-derived) — a separate ad hoc
# $HEADLESSCODE_SHARED_DIR copy path here previously diverged from that and
# silently installed to the wrong place (issue #10's review finding).
bash "$HARNESS_ROOT/scripts/sync-shared-rules.sh"
if ! command -v headlesscode >/dev/null 2>&1; then
    echo "warning: $INSTALL_DIR is not on your PATH" >&2
fi
