#!/usr/bin/env bash
set -uo pipefail

# Guided-phase research harness with a real review gate (issue #152's
# lesson applied): a researcher-mode session against the code-daemon
# (qwen3-14b) produces an artifact; the SAME artifact is then judged
# against an ITEMIZED rubric by the review-daemon (2080,
# deepseek-r1-distill-qwen-7b) — not a generic "is this good?" question
# (which #146's judge call showed can misread a transcript), but explicit
# yes/no checks tied to the task's actual required content. On FAIL, one
# corrective retry is dispatched: a fresh researcher session, told
# EXACTLY which itemized checks failed and why, editing the SAME file.
#
# Usage: scripts/eval-suite/guided-research-with-review.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARTIFACT="plans/eval-suite-stage1-scenarios-v2.md"
SCRATCH="$REPO_ROOT/.headlesscode/scratch/eval-suite"
mkdir -p "$SCRATCH"

TASK_FILE="$REPO_ROOT/TASK_guided_research_$STAMP.md"
LOG1="$SCRATCH/guided-research-$STAMP-phase1.log"

cat > "$TASK_FILE" <<EOF
## Rules
- Unattended: never use ask_followup_question, never use switch_mode.
- Fresh process, zero memory of any other session.
- Tools: read-only plus editing .md files only. Budget: at most 20
  read_file/list_files/execute_command calls before you must act.

## Background (issue #151, stage 1 of 3)
Two specific, already-diagnosed gaps are your targets:

Gap A — issue #146: no guardrail existed for a tool failing repeatedly
with VARIED args. (This has since been FIXED in src/engine/loop.ts —
search for "toolFailureStreakName" to see the real fix and its doc
comment, which explains the exact live-observed failure shape.)

Gap B — issue #150: a session's process can die completely silently
mid-run, no exit code, no error log, no trace. Verify yourself: grep
src/engine/loop.ts for SIGTERM, uncaughtException, and
unhandledRejection and confirm whether any process-level handler
guarantees a final log line before the process exits on every path.

## Task
Write ONE document at \`$ARTIFACT\` describing TWO new synthetic test
SCENARIOS (specs, not code): Scenario 1 must describe a NEW scenario
for issue #150 specifically (Gap A / #146 already has both a real fix
AND real unit tests now — a #146 scenario would be redundant; do NOT
write about #146). For Scenario 2, describe a scenario verifying the
FIX for #146 behaves correctly under a DIFFERENT real-world shape than
the existing unit tests already cover (read
src/engine/__tests__/loop.test.ts and grep for "toolFailure" to see
what's already tested — your Scenario 2 must be a genuinely different
shape, e.g. a multi-tool-batch turn, or interaction with the identical
call cooldown described in issue #153).

For EACH scenario: a short name, the exact tool-call sequence (prose,
not code) that would trigger it, what correct harness behavior looks
like, and a concrete PASS/FAIL signal for when it's actually run.

Required content: the literal phrases "Scenario 1", "Scenario 2", and
"Why This Wasn't Already Covered" must appear, with at least 4 real
file:line citations you verify yourself via read_file — do not copy a
line number without confirming it still matches.

## What NOT to do
- Do not touch src/. Do not propose an implementation/fix — that's a
  separate future stage. Do not write a Scenario 1 about #146 — that
  gap is closed now, re-covering it would be redundant, not a new
  finding.

When done, call attempt_completion with the file path as your result.
EOF

echo "=== Phase 1: researcher session (code-daemon, qwen3-14b) ==="
cd "$REPO_ROOT"
HEADLESSCODE_CODE_MODE_BACKEND=ollama \
HEADLESSCODE_LOCAL_BACKEND_MODES=researcher \
HEADLESSCODE_OLLAMA_URL__RESEARCHER=http://localhost:11435 \
HEADLESSCODE_CODE_MODE_MODEL__RESEARCHER=qwen3-14b:latest \
npx tsx src/cli.ts \
	--mode researcher \
	--task-file "$TASK_FILE" \
	--workspace "$REPO_ROOT" \
	--require-artifact-path "$ARTIFACT" \
	--require-artifact-min-citations 4 \
	--require-artifact-sections "Scenario 1|Scenario 2|Why This Wasn't Already Covered" \
	--log-file "$LOG1" \
	> "$LOG1.stdout" 2>&1
echo "phase 1 exit: $?"

review_doc() {
	local doc_path="$1"
	local out_file="$2"
	python3 - "$doc_path" "$out_file" <<'PYEOF'
import json, sys, urllib.request

doc_path, out_file = sys.argv[1], sys.argv[2]
with open(doc_path) as f:
    content = f.read()

question = f"""You are reviewing a document written by an AI coding agent against an ITEMIZED checklist. Answer each item with YES or NO based STRICTLY on the actual document content below — do not assume, only judge what is literally present.

CHECKLIST:
1. Does the document contain a scenario specifically about issue #150 (a session process dying silently mid-run, with no exit code or error log)?
2. Does the document contain a SECOND, DIFFERENT scenario testing issue #146's fix (the repeated-tool-failure guardrail) in a shape NOT identical to "edit_file fails twice with varied args"?
3. Does the document explicitly explain, with real file:line citations, why neither scenario is already covered by an existing test?
4. Is the document free of generic, unrelated content (e.g. "Task Execution Flow", "Concurrent Read-Only Call Handling", or other topics not related to #146/#150)?

DOCUMENT:
---
{content}
---

Respond in EXACTLY this format, nothing else:
1: YES or NO
2: YES or NO
3: YES or NO
4: YES or NO
OVERALL: PASS or FAIL
REASON: <one sentence>
"""

payload = json.dumps({
    "model": "deepseek-r1-distill-qwen-7b:latest",
    "messages": [{"role": "user", "content": question}],
    "stream": False,
}).encode()

req = urllib.request.Request(
    "http://127.0.0.1:11500/api/chat",
    data=payload,
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=180) as resp:
    data = json.load(resp)

result = data["message"]["content"]
with open(out_file, "w") as f:
    f.write(result)
print(result)
PYEOF
}

if [ ! -f "$REPO_ROOT/$ARTIFACT" ]; then
	echo "PHASE 1 FAILED: $ARTIFACT was never created."
	exit 1
fi

echo ""
echo "=== Phase 2: review-daemon judgment (2080, deepseek-r1-distill-qwen-7b) ==="
REVIEW1="$SCRATCH/guided-research-$STAMP-review1.txt"
review_doc "$REPO_ROOT/$ARTIFACT" "$REVIEW1"

# Pull just the OVERALL line (the judge's chain-of-thought before it can
# otherwise contain the string "FAIL" in passing, e.g. "did NOT fail") —
# grep for the specific "OVERALL:" line and normalize whitespace/case.
overall="$(grep -oiE 'OVERALL:[[:space:]]*(PASS|FAIL)' "$REVIEW1" | tail -1 | tr '[:upper:]' '[:lower:]')"

if [[ "$overall" == *fail* ]]; then
	echo ""
	echo "=== Review FAILED. Dispatching ONE corrective retry (bounded — no further retries after this). ==="
	RETRY_TASK_FILE="$REPO_ROOT/TASK_guided_research_retry_$STAMP.md"
	LOG3="$SCRATCH/guided-research-$STAMP-phase3.log"

	cat > "$RETRY_TASK_FILE" <<EOF
## Rules
- Unattended: never use ask_followup_question, never use switch_mode.
- Fresh process, zero memory of any other session — you have never seen
  the file below before this task told you about it.
- Tools: read-only plus editing .md files only.

## Task
An independent reviewer already read \`$ARTIFACT\` (which exists — read
it yourself first) and rejected it against this checklist:

$(cat "$REVIEW1")

Fix the document to genuinely satisfy every item the review marked NO
(or the overall verdict, if individual items aren't clear from the text
above) — edit \`$ARTIFACT\` in place using edit_file. Do not rewrite
parts that were already fine. Every citation you add or keep must be
verified by YOU via read_file immediately before writing it — a wrong
line-number-but-plausible-claim citation is exactly the kind of defect
that gets caught later (see issue #152/#153 if you want the full
history), so re-verify, don't assume the existing ones are already
correct either.

When done, call attempt_completion with the file path as your result.
EOF

	cd "$REPO_ROOT"
	HEADLESSCODE_CODE_MODE_BACKEND=ollama \
	HEADLESSCODE_LOCAL_BACKEND_MODES=researcher \
	HEADLESSCODE_OLLAMA_URL__RESEARCHER=http://localhost:11435 \
	HEADLESSCODE_CODE_MODE_MODEL__RESEARCHER=qwen3-14b:latest \
	npx tsx src/cli.ts \
		--mode researcher \
		--task-file "$RETRY_TASK_FILE" \
		--workspace "$REPO_ROOT" \
		--require-artifact-path "$ARTIFACT" \
		--require-artifact-min-citations 4 \
		--require-artifact-sections "Scenario 1|Scenario 2|Why This Wasn't Already Covered" \
		--log-file "$LOG3" \
		> "$LOG3.stdout" 2>&1
	echo "phase 3 (retry) exit: $?"

	echo ""
	echo "=== Phase 4: re-review after the corrective retry ==="
	REVIEW2="$SCRATCH/guided-research-$STAMP-review2.txt"
	review_doc "$REPO_ROOT/$ARTIFACT" "$REVIEW2"
	overall2="$(grep -oiE 'OVERALL:[[:space:]]*(PASS|FAIL)' "$REVIEW2" | tail -1 | tr '[:upper:]' '[:lower:]')"

	echo ""
	echo "Artifact:      $REPO_ROOT/$ARTIFACT"
	echo "Review 1:      $REVIEW1 ($overall)"
	echo "Retry task:    $RETRY_TASK_FILE"
	echo "Review 2:      $REVIEW2 ($overall2)"
	if [[ "$overall2" == *fail* ]]; then
		echo "FINAL: still FAILING after the one bounded retry — needs a human/Claude look, not another automatic retry."
	else
		echo "FINAL: PASS after one corrective retry."
	fi
else
	echo ""
	echo "Artifact: $REPO_ROOT/$ARTIFACT"
	echo "Review:   $REVIEW1 (PASS — no retry needed)"
fi
