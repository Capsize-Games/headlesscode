#!/usr/bin/env bash
set -euo pipefail

# Reusable commit-dispatch helper (issue #154's fix direction 3).
#
# Two DISTINCT local-model failure modes were observed live 2026-08-21
# dispatching commits via an inline `git commit -m "$(cat <<'EOF' ... EOF)"`
# heredoc in a task file:
#   1. Running `git log` right before the prescribed commit made the model
#      reuse a DIFFERENT, unrelated PRIOR commit message it had just seen
#      in that output, instead of the one it was given (confirmed 2x).
#   2. A very long multi-paragraph message got truncated mid-generation —
#      the model submitted `git add <files> &&` with nothing after it, 3x
#      in a row, never reaching a real `git commit` at all.
#
# Both share a root cause: asking the model to REPRODUCE the commit
# message as part of its own generated command. This script removes that
# requirement structurally: the message lives in a real file on disk, and
# the model's own command is always the same short, fixed shape —
# `git add <files> && git commit -F <message-file>` — regardless of how
# long or complex the message is.
#
# Usage: scripts/dispatch-commit.sh <message-file> <file1> [file2 ...]
#
# <message-file> must already exist with the real commit message content.
# Verifies tsc is clean, dispatches the commit to the code-daemon, then
# verifies the commit actually landed with the exact message from the
# file (byte-for-byte) before reporting success.

if [ $# -lt 2 ]; then
	echo "Usage: $0 <message-file> <file1> [file2 ...]" >&2
	exit 2
fi

MESSAGE_FILE="$1"
shift
FILES=("$@")

if [ ! -f "$MESSAGE_FILE" ]; then
	echo "Message file not found: $MESSAGE_FILE" >&2
	exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
TASK_FILE="$REPO_ROOT/TASK_dispatch_commit_$STAMP.md"
LOG="$REPO_ROOT/.headlesscode/scratch/dispatch-commit-$STAMP.log"
mkdir -p "$REPO_ROOT/.headlesscode/scratch"

# Absolute path to the message file so the dispatched session (workspace
# root = repo root) can reference it regardless of where it was created.
ABS_MESSAGE_FILE="$(cd "$(dirname "$MESSAGE_FILE")" && pwd)/$(basename "$MESSAGE_FILE")"

cat > "$TASK_FILE" <<EOF
## Rules
- Unattended: never use ask_followup_question.
- All changes are DONE and already verified working. Do not edit any
  of the files being committed, and do not edit $ABS_MESSAGE_FILE.
- Do NOT run \`git log\` at any point in this task — use \`git status
  --short\` if you need to check state.

## Task

1. Run \`npx tsc --noEmit -p .\` — must be clean (no output, exit 0).
2. Only after it passes for real, run this EXACT command, unmodified,
   via execute_command (the commit message is in a FILE — do not
   retype or paraphrase it, the command just references the file path):

git add ${FILES[*]} && git commit -F "$ABS_MESSAGE_FILE"

3. Run \`git status --short\` (NOT git log) to confirm the working
   tree is clean after the commit.

When step 3 confirms a clean tree, call attempt_completion with the
result of \`git rev-parse HEAD\` as your result.
EOF

echo "=== Dispatching commit (code-daemon, qwen3-14b) ==="
cd "$REPO_ROOT"
HEADLESSCODE_CODE_MODE_BACKEND=ollama \
HEADLESSCODE_LOCAL_BACKEND_MODES=code \
HEADLESSCODE_OLLAMA_URL=http://localhost:11435 \
HEADLESSCODE_CODE_MODE_MODEL=qwen3-14b:latest \
npx tsx src/cli.ts \
	--mode code \
	--task-file "$TASK_FILE" \
	--workspace "$REPO_ROOT" \
	--max-iterations 12 \
	--log-file "$LOG" \
	> "$LOG.stdout" 2>&1
DISPATCH_EXIT=$?
echo "dispatch exit: $DISPATCH_EXIT"

# Scoped to the SPECIFIC files this dispatch was told to commit, not the
# whole working tree — a bare `git status --short` false-positived here
# live 2026-08-21 when a second, unrelated dispatch running concurrently
# against the same workspace left its own untracked scratch file sitting
# around at the moment this check ran. The commit had actually landed
# correctly; this script just misread someone else's mess as its own
# failure. `-- "${FILES[@]}"` restricts git status to exactly the paths
# this dispatch owns.
if [ -n "$(git status --short -- "${FILES[@]}")" ]; then
	echo "FAILED: the specific files this dispatch was told to commit are still dirty — commit did not land." >&2
	echo "See $LOG.stdout for the transcript." >&2
	rm -f "$TASK_FILE"
	exit 1
fi

ACTUAL_MSG="$(git log -1 --pretty=%B)"
EXPECTED_MSG="$(cat "$MESSAGE_FILE")"
rm -f "$TASK_FILE"

if [ "$ACTUAL_MSG" != "$EXPECTED_MSG" ]; then
	echo "WARNING: commit landed but the message does NOT match the message file byte-for-byte." >&2
	echo "Landed commit: $(git rev-parse HEAD)" >&2
	exit 1
fi

echo "OK: commit landed with the exact prescribed message: $(git rev-parse HEAD)"
