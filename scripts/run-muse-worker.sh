#!/usr/bin/env bash
# Run one non-interactive native Muse session and validate its terminal record.
# Called by run-worker.sh inside the worker's supervised process group.
set -euo pipefail

# Muse's Meta provider does not need HeadlessCode/OpenRouter credentials or
# model selectors. Do not forward those unrelated settings to the CLI.
unset OPENROUTER_API_KEY HEADLESSCODE_OPENROUTER_API_KEY OPENROUTER_MODEL

if [ "$#" -ne 4 ]; then
    echo "Usage: $0 <worktree> <prompt-file> <native-model-or-empty> <max-model-steps-or-empty>" >&2
    exit 2
fi

WORKSPACE="$1"
PROMPT_FILE="$2"
MODEL="$3"
MAX_MODEL_STEPS="$4"

if [ ! -d "$WORKSPACE" ] || [ ! -s "$PROMPT_FILE" ]; then
    echo "run-muse-worker: workspace must exist and prompt file must be non-empty" >&2
    exit 2
fi
if ! command -v muse >/dev/null 2>&1; then
    echo "run-muse-worker: 'muse' is not installed or not on PATH" >&2
    exit 2
fi
if [ -n "$MODEL" ] && ! [[ "$MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$ ]]; then
    echo "run-muse-worker: invalid native Muse model identifier" >&2
    exit 2
fi
if [ -n "$MAX_MODEL_STEPS" ] && ! [[ "$MAX_MODEL_STEPS" =~ ^[1-9][0-9]{0,5}$ ]]; then
    echo "run-muse-worker: max model steps must be an integer from 1 to 999999" >&2
    exit 2
fi

SESSION_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
if ! [[ "$SESSION_ID" =~ ^[a-fA-F0-9-]{36}$ ]]; then
    echo "run-muse-worker: failed to generate a session id" >&2
    exit 2
fi
mkdir -p "$WORKSPACE/.headlesscode/scratch"
printf '%s' "$SESSION_ID" > "$WORKSPACE/.headlesscode/scratch/muse-session-id"
EVENTS="$(mktemp "$WORKSPACE/.harness-muse-events.XXXXXXXX")"
STDERR_FILE="$(mktemp "$WORKSPACE/.harness-muse-stderr.XXXXXXXX")"
cleanup() { rm -f -- "$EVENTS" "$STDERR_FILE"; }
trap cleanup EXIT

ARGS=(exec --provider meta --json --no-foreign-personal-context --prompt-file "$PROMPT_FILE" --workspace "$WORKSPACE" --session-id "$SESSION_ID")
[ -n "$MODEL" ] && ARGS+=(--model "$MODEL")
[ -n "$MAX_MODEL_STEPS" ] && ARGS+=(--max-model-steps "$MAX_MODEL_STEPS")
printf 'Muse executor: provider=meta model=%s session=%s\n' "${MODEL:-<Muse default>}" "$SESSION_ID"

# Muse is non-interactive here. Its stdin is closed, and stdout remains visible
# in the shared harness log while an independent copy is retained for checking
# the JSONL run terminal. Continuation/task ids are not completion signals.
set +e
muse "${ARGS[@]}" </dev/null 2>"$STDERR_FILE" | tee "$EVENTS" | tee -a "$WORKSPACE/harness.log" >/dev/null
MUSE_CODE=${PIPESTATUS[0]}
set -e
if [ -s "$STDERR_FILE" ]; then
    cat "$STDERR_FILE" >&2
    cat "$STDERR_FILE" >> "$WORKSPACE/harness.log"
fi

# A zero exit status alone is insufficient: JSONL must contain a terminal run
# completion. In particular, a run.terminal.failed event must never be hidden
# by preceding task/session continuation records.
set +e
node - "$EVENTS" <<'NODE'
const fs = require('node:fs')
const p = process.argv[2]
let terminalEvent
try {
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) process.exit(2)
  for (const line of lines) {
    const event = JSON.parse(line)
    if (typeof event.payload_type === 'string' && event.payload_type.startsWith('run.terminal.')) {
      terminalEvent = event
    }
  }
} catch {
  process.exit(2)
}
if (terminalEvent?.payload_type === 'run.terminal.completed' &&
    terminalEvent.payload?.kind === 'run_terminal' &&
    terminalEvent.payload?.terminal === 'completed' &&
    terminalEvent.payload?.reason === null &&
    !terminalEvent.payload?.error) process.exit(0)
process.exit(1)
NODE
JSON_CODE=$?
set -e

if [ "$MUSE_CODE" -ne 0 ]; then
    exit "$MUSE_CODE"
fi
if [ "$JSON_CODE" -ne 0 ]; then
    echo "run-muse-worker: Muse returned without run.terminal.completed in valid JSONL; treating run as failed" >&2
    echo "run-muse-worker: Muse returned without run.terminal.completed in valid JSONL; treating run as failed" >> "$WORKSPACE/harness.log"
    exit 1
fi
exit 0
