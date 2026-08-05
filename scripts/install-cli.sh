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

echo "Installed headlesscode -> $TARGET (harness: $HARNESS_ROOT)"

# Install the shipped stack-rules content (shared/stacks/<stack>/rules.md)
# into the machine-global central store — this is what "ships with
# headlesscode" means for the central tier (see docs/stack-rules.md).
# Routes through the SAME resolution getCentralStackRulesDir() uses
# (projectStoreRoot()/$HEADLESSCODE_DATA_DIR) — a separate ad hoc
# $HEADLESSCODE_SHARED_DIR copy path here previously diverged from that and
# silently installed to the wrong place (issue #10's review finding).
bash "$HARNESS_ROOT/scripts/sync-stack-rules.sh"
if ! command -v headlesscode >/dev/null 2>&1; then
    echo "warning: $INSTALL_DIR is not on your PATH" >&2
fi
