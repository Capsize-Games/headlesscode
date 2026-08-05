#!/usr/bin/env bash
# install-cli.sh — install a systemwide `headlesscode` command.
#
# Writes a small wrapper to ~/.local/bin/headlesscode that execs this
# checkout's tsx + src/cli.ts, while preserving the caller's cwd (so
# `headlesscode`'s own --repo/--workspace defaulting to process.cwd()
# still targets whatever project the user is standing in, not this repo).
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

# Ship the central stack-rules content (`shared/stacks/<stack>/rules.md`)
# into the runtime's central store, so stack-specific instructions actually
# reach worker system prompts. Same location + override the runtime resolves:
# $HEADLESSCODE_DATA_DIR, else $HOME/.local/share/headlesscode/shared/stacks
# (see src/project-store.ts:projectStoreRoot + src/engine/stacks.ts).
STACKS_SRC="$HARNESS_ROOT/shared/stacks"
if [ -d "$STACKS_SRC" ]; then
    STACKS_DEST="${HEADLESSCODE_DATA_DIR:-$HOME/.local/share/headlesscode}/shared/stacks"
    mkdir -p "$STACKS_DEST"
    cp -R "$STACKS_SRC"/. "$STACKS_DEST"/
    echo "Installed stack rules -> $STACKS_DEST"
fi

echo "Installed headlesscode -> $TARGET (harness: $HARNESS_ROOT)"
if ! command -v headlesscode >/dev/null 2>&1; then
    echo "warning: $INSTALL_DIR is not on your PATH" >&2
fi
