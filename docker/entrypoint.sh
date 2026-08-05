#!/bin/sh
# ---------------------------------------------------------------------------
# headlesscode container entrypoint.
#
# 1. Ensure the /data volume layout exists. The compose stack mounts the
#    named `server_data` volume at /data; that mount shadows whatever the
#    image build created, so the workspace/state dirs must be (re)created
#    at every container start.
# 2. Set a usable git identity. The harness shells out to git (worktree
#    spawn, shadow-git checkpoints, reviewers); without user.name/email any
#    commit fails. Override via GIT_AUTHOR_NAME/EMAIL (and the standard
#    GIT_COMMITTER_* pair) — the env-file convention, like every other
#    headlesscode setting.
# ---------------------------------------------------------------------------
set -e

mkdir -p "$HEADLESSCODE_WORKSPACE_ROOT" "$HOME"

# Seed the shipped stack rules into the central store
# ($HOME/.local/share/headlesscode/shared/stacks). $HOME lives on the /data
# volume, which shadows image layers, so this must run at every start.
STACKS_SRC=/opt/headlesscode/shared/stacks
if [ -d "$STACKS_SRC" ]; then
	mkdir -p "$HOME/.local/share/headlesscode/shared/stacks"
	cp -R "$STACKS_SRC"/. "$HOME/.local/share/headlesscode/shared/stacks"/
fi

if ! git config --global user.name >/dev/null 2>&1; then
	git config --global user.name "${GIT_AUTHOR_NAME:-headlesscode}"
fi
if ! git config --global user.email >/dev/null 2>&1; then
	git config --global user.email "${GIT_AUTHOR_EMAIL:-headlesscode@localhost}"
fi

exec "$@"
