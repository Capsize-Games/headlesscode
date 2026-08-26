#!/usr/bin/env bash
# smart-log-watch.sh — tail a headlesscode session log and use the local
# review daemon (RTX 2080) to triage it: only print a line (which Monitor
# turns into a notification) when something actually needs a human/
# supervisor's attention, instead of firing on every iteration line.
#
# Usage: scripts/smart-log-watch.sh <logfile> [poll-seconds]
set -euo pipefail

LOGFILE="${1:?usage: smart-log-watch.sh <logfile> [poll-seconds]}"
POLL="${2:-60}"
REVIEW_URL="${HEADLESSCODE_OLLAMA_URL__DEEPSEEK_REVIEWER:-http://127.0.0.1:11500}"
REVIEW_MODEL="${HEADLESSCODE_CODE_MODE_MODEL__DEEPSEEK_REVIEWER:-deepseek-r1-distill-qwen-7b:latest}"

echo "[smart-log-watch] watching $LOGFILE via $REVIEW_URL every ${POLL}s"

LAST_SIZE=0
while true; do
	sleep "$POLL"
	[ -f "$LOGFILE" ] || continue
	CUR_SIZE=$(wc -c < "$LOGFILE" 2>/dev/null || echo 0)
	if [ "$CUR_SIZE" -eq "$LAST_SIZE" ]; then
		echo "[smart-log-watch] NO PROGRESS: log size unchanged for ${POLL}s (${CUR_SIZE} bytes) — session may be hung"
		continue
	fi
	LAST_SIZE="$CUR_SIZE"

	# Cheap, deterministic loop detector BEFORE spending an LLM call:
	# a narrow tail window looks like "normal recovery" even when the
	# session has been re-reading the same file/anchor for 50+
	# iterations — this bit us in round 3 of the 2026-08-21 full-cycle
	# demo (the watcher never flagged an 80-iteration read_file loop on
	# src/engine/loop.ts because each 90s snapshot looked locally fine).
	# grep the read_file "arg" field across a MUCH longer window and
	# flag if the same target repeats too often.
	REPEAT_TARGET=$(tail -n 400 "$LOGFILE" 2>/dev/null | grep -oE '"arg":"[^"]*"' | sort | uniq -c | sort -rn | head -1)
	REPEAT_COUNT=$(echo "$REPEAT_TARGET" | awk '{print $1}')
	if [ -n "$REPEAT_COUNT" ] && [ "$REPEAT_COUNT" -ge 15 ] 2>/dev/null; then
		echo "[smart-log-watch] ATTENTION: same tool-call target repeated ${REPEAT_COUNT}x in the last 400 log lines (${REPEAT_TARGET}) — likely an unproductive read loop, not real progress"
		continue
	fi
	# Bug found live 2026-08-21 (round 7): a FAILED tool result logs as
	# `tool result: edit_file {"isError":true,"toolCalls":N}` — no "arg"
	# field at all, so the check above is structurally blind to a tool
	# repeatedly FAILING with varied args (62 straight edit_file
	# failures went completely undetected this way for a full 20-minute
	# round). Count failed-result lines per tool name instead, no "arg"
	# dependency.
	FAIL_TARGET=$(tail -n 400 "$LOGFILE" 2>/dev/null | grep -oE 'tool result: [a-z_]+ \{"isError":true' | sort | uniq -c | sort -rn | head -1)
	FAIL_COUNT=$(echo "$FAIL_TARGET" | awk '{print $1}')
	if [ -n "$FAIL_COUNT" ] && [ "$FAIL_COUNT" -ge 10 ] 2>/dev/null; then
		echo "[smart-log-watch] ATTENTION: same tool failed ${FAIL_COUNT}x in the last 400 log lines (${FAIL_TARGET}) — likely stuck thrashing, not real progress"
		continue
	fi

	TAIL=$(tail -c 8000 "$LOGFILE" 2>/dev/null | tr -d '\000')
	PROMPT=$(python3 -c '
import json, sys
tail = sys.argv[1]
prompt = (
    "You are triaging a log tail from an autonomous coding-agent session. "
    "Reply with EXACTLY one line: either \"OK: <one-sentence reason>\" if the "
    "session looks like it is making normal progress (even if slow, even if "
    "recovering from a minor tool-call formatting mistake), or \"ATTENTION: "
    "<one-sentence reason>\" if it looks genuinely stuck (the same exact error "
    "repeating many times with zero progress), has fabricated a claim "
    "(claims to have created/filed/committed something with no real tool call "
    "backing it in this excerpt), or has crashed/hit a fatal error. "
    "Do not write anything except that one line.\n\nLOG TAIL:\n" + tail
)
print(json.dumps({"model": sys.argv[2], "messages": [{"role": "user", "content": prompt}], "stream": False}))
' "$TAIL" "$REVIEW_MODEL")

	RESPONSE=$(curl -s -m 60 -H "Content-Type: application/json" --data-binary "$PROMPT" "$REVIEW_URL/api/chat" 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("message", {}).get("content", "").strip().splitlines()[-1] if d.get("message") else "")
except Exception:
    print("")
' 2>/dev/null || true)

	if [ -n "$RESPONSE" ] && echo "$RESPONSE" | grep -qi "^ATTENTION"; then
		echo "[smart-log-watch] $RESPONSE"
	fi
done
