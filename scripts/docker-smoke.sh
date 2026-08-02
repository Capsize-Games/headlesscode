#!/usr/bin/env bash
#
# docker-smoke.sh — build the headlesscode image and prove the install works
# INSIDE a container (see docs/airunner-docker-packaging.md).
#
#   scripts/docker-smoke.sh [image-tag]     (default tag: headlesscode:0.1.0)
#
# Verifies, in order:
#   1. The image builds (source COPY + `npm ci` inside the image).
#   2. `headlesscode --version` runs in the container (Node + tsx work).
#   3. `headlesscode --dry-run` — builds the system prompt + validates
#      config with NO API key and NO LLM call.
#   4. `headlesscode orchestrate --dry-run` against a scratch git repo with
#      `--issues-json` — proves git + the orchestrator CLI path work
#      (avoids needing the `gh` CLI; dry-run needs no API key).
#   5. The /data volume convention: with a volume mounted at /data, the
#      entrypoint creates /data/headlesscode-workspaces + HOME on first
#      start, and `headlesscode --version` still runs from that state root.
#   6. The runtime orchestration scripts (spawn-parallel-worktrees.sh,
#      run-worker.sh, headlesscode-answer.sh) exist and are executable in
#      the image — a real non-dry-run orchestrate run shells out to them.
#
# Requires: docker (classic or buildx), network access for npm ci.
# Exit code: 0 = PASS, 1 = FAIL.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-headlesscode:0.1.0}"
VOLUME="headlesscode-smoke-data"

PASS=0
FAIL=0
fail() { FAIL=$((FAIL + 1)); echo "  FAIL  $*"; }
pass() { PASS=$((PASS + 1)); echo "  ok    $*"; }

cleanup() {
	docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$ROOT"

echo "==> [1/6] building image: docker build -t $TAG -f docker/Dockerfile ."
if ! docker build -t "$TAG" -f docker/Dockerfile .; then
	echo "FATAL: image build failed — see output above"
	exit 1
fi
pass "image built: $TAG"

echo
echo "==> [2/6] headlesscode --version"
VERSION_OUT="$(docker run --rm "$TAG" headlesscode --version 2>&1)"
VERSION_STATUS=$?
if [ "$VERSION_STATUS" -ne 0 ]; then
	fail "headlesscode --version exited $VERSION_STATUS"
	echo "$VERSION_OUT"
fi
echo "  output: $VERSION_OUT"
case "$VERSION_OUT" in
	headlesscode\ *) pass "version check: $VERSION_OUT" ;;
	*) fail "unexpected --version output: $VERSION_OUT" ;;
esac

echo
echo "==> [3/6] headlesscode --dry-run (no API key / no LLM)"
DRYRUN_OUT="$(docker run --rm -w /workspace "$TAG" headlesscode --dry-run --workspace /workspace 2>&1)"
DRYRUN_STATUS=$?
if [ "$DRYRUN_STATUS" -ne 0 ]; then
	fail "headlesscode --dry-run exited $DRYRUN_STATUS"
	echo "$DRYRUN_OUT"
fi
echo "$DRYRUN_OUT" | sed 's/^/  /' | tail -8
if grep -q "dry-run summary" <<<"$DRYRUN_OUT" && grep -q "system prompt:" <<<"$DRYRUN_OUT"; then
	pass "dry-run produced the system-prompt summary"
else
	fail "dry-run summary missing from output"
fi

echo
echo "==> [4/6] headlesscode orchestrate --dry-run (scratch git repo + --issues-json)"
# The inner script runs INSIDE the container; the /data volume is shared, so
# the scratch repo + issues file written here are visible there.
INNER_SCRIPT=$(cat <<'EOS'
set -e
git init -q /data/scratch-repo
git -C /data/scratch-repo config user.email smoke@headlesscode.local
git -C /data/scratch-repo config user.name smoke
cat > /data/issues.json <<'JSON'
[{"number": 1, "title": "smoke issue", "body": "no-op smoke issue"}]
JSON
headlesscode orchestrate --repo /data/scratch-repo --issues-json /data/issues.json --dry-run
EOS
)
ORCH_OUT="$(printf '%s\n' "$INNER_SCRIPT" | docker run --rm -i -v "$VOLUME:/data" -w /data "$TAG" bash -s 2>&1)"
ORCH_STATUS=$?
if [ "$ORCH_STATUS" -ne 0 ]; then
	fail "orchestrate --dry-run exited $ORCH_STATUS"
	echo "$ORCH_OUT"
fi
echo "$ORCH_OUT" | sed 's/^/  /' | head -14
if grep -q "worker:\|mode:\|Issues\|Wrote" <<<"$ORCH_OUT"; then
	pass "orchestrate --dry-run printed the round plan"
else
	fail "orchestrate --dry-run plan missing from output"
fi

echo
echo "==> [5/6] /data volume convention (state dirs created on the volume)"
DATA_OUT="$(docker run --rm -v "$VOLUME:/data" "$TAG" bash -c 'ls -d /data/headlesscode-workspaces /data/headlesscode-home && cd /data/headlesscode-workspaces && headlesscode --version' 2>&1)"
DATA_STATUS=$?
if [ "$DATA_STATUS" -ne 0 ]; then
	fail "volume state-dir check exited $DATA_STATUS"
	echo "$DATA_OUT"
fi
echo "$DATA_OUT" | sed 's/^/  /'
if grep -q "headlesscode-workspaces" <<<"$DATA_OUT" && grep -q "headlesscode-home" <<<"$DATA_OUT" && grep -q "^headlesscode" <<<"$DATA_OUT"; then
	pass "entrypoint created /data state dirs; CLI runs from the volume"
else
	fail "volume state-dir check did not pass"
fi

echo
echo "==> [6/6] runtime orchestration scripts present + executable"
SCRIPTS_OUT="$(docker run --rm "$TAG" bash -c 'ls -l /opt/headlesscode/scripts/ && for f in spawn-parallel-worktrees.sh run-worker.sh headlesscode-answer.sh; do test -x /opt/headlesscode/scripts/$f || exit 1; done' 2>&1)"
SCRIPTS_STATUS=$?
if [ "$SCRIPTS_STATUS" -ne 0 ]; then
	fail "runtime scripts check exited $SCRIPTS_STATUS"
	echo "$SCRIPTS_OUT"
fi
echo "$SCRIPTS_OUT" | sed 's/^/  /'
if [ "$SCRIPTS_STATUS" -eq 0 ]; then
	pass "orchestration scripts present + executable in the image"
else
	fail "runtime orchestration scripts missing or not executable"
fi

echo
echo "============================================================"
echo "  docker smoke: $PASS passed, $FAIL failed"
echo "============================================================"
[ "$FAIL" -eq 0 ]
