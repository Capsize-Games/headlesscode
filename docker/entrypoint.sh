#!/bin/sh
# ---------------------------------------------------------------------------
# headlesscode container entrypoint.
#
# 1. Ensure the /data volume layout exists. The compose stack mounts the
#    named `server_data` volume at /data; that mount shadows whatever the
#    image build created, so the workspace/state dirs must be (re)created
#    at every container start.
# 2. Seed the central shared store (per-stack rules.md, …) from the image
#    copy into $HOME — same reason: the volume shadows image content, so
#    the seed must run at every start.
# 3. Set a usable git identity. The harness shells out to git (worktree
#    spawn, shadow-git checkpoints, reviewers); without user.name/email any
#    commit fails. Override via GIT_AUTHOR_NAME/EMAIL (and the standard
#    GIT_COMMITTER_* pair) — the env-file convention, like every other
#    headlesscode setting.
# ---------------------------------------------------------------------------
set -e

mkdir -p "$HEADLESSCODE_WORKSPACE_ROOT" "$HOME"

# Seed the shipped central shared content (per-stack rules.md +
# shared/rules-code/rules.md) into the central store the runtime reads
# (stacks via src/engine/stacks.ts:getCentralStackRulesDir, rules-code via
# the vendored roo-config getGlobalRooDirectory, both under
# $HEADLESSCODE_DATA_DIR/shared, else $HOME/.local/share/headlesscode/shared —
# the same resolution install-cli.sh uses). $HOME lives on the /data volume,
# which shadows image layers, so this must run at every start. Idempotent:
# only ever adds/overwrites files under the image's shared/ tree — never
# deletes anything a user placed in the central store.
for sub in stacks rules-code; do
	SRC="/opt/headlesscode/shared/$sub"
	if [ -d "$SRC" ]; then
		DEST="${HEADLESSCODE_DATA_DIR:-$HOME/.local/share/headlesscode}/shared/$sub"
		mkdir -p "$DEST"
		cp -R "$SRC"/. "$DEST"/
	fi
done

if ! git config --global user.name >/dev/null 2>&1; then
	git config --global user.name "${GIT_AUTHOR_NAME:-headlesscode}"
fi
if ! git config --global user.email >/dev/null 2>&1; then
	git config --global user.email "${GIT_AUTHOR_EMAIL:-headlesscode@localhost}"
fi

exec "$@"
