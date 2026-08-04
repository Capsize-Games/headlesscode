# Decision-proxy agent — LLM stand-in for the human on `ask_followup_question`

Status: **piloted live, single-worktree v1 shipped** (see "Pilot results").
Implements: `src/decision-proxy/` (proxy + CLI subcommand) + a 3-line
`switch_mode` tolerance in `src/engine/loop.ts`.

## What it is

A small process that watches a workspace for the `.harness.needs-decision`
marker that `ask_followup_question` (and `switch_mode`, sharing the same
primitive) writes, and answers it by writing `.harness.decision-answer` —
**the exact file a human writes via `scripts/headlesscode-answer.sh`** — so a
headless session never sits blocked for the full decision timeout on a
question its own task can answer.

**No change to `escalateDecision` / `ask_followup_question` themselves.** The
proxy is an additive writer of the same answer file. The existing
timeout → "must decide autonomously" fallback stays untouched and remains the
safety net: if the proxy abstains or breaks, the session behaves exactly as it
did with no proxy at all.

## The three outcomes per question

1. **answered** — the original task text grounds a specific answer → write
   `[decision-proxy] <answer>` to the answer file. The `[decision-proxy] `
   prefix makes every proxy-authored answer distinguishable from a human one
   in `harness.log` / the dashboard's `decision_answered` event (the
   structural audit trail; no eval-test suite was built — explicitly deferred).
2. **uncertain** — the model reports it cannot ground an answer, or no task
   text is available → write NOTHING. The worker's poll loop keeps waiting and
   today's timeout fallback fires exactly as it would with no proxy. This is
   the deliberate design: no stakes-based gating, no fabricating low-confidence
   answers — the proxy recognizes its own uncertainty and says so.
3. **errored** — LLM call failed/timed out, or the response was malformed →
   write NOTHING. Fail closed on parse ambiguity (a non-JSON reply is never
   treated as license to answer), fail open to today's behavior.

Every question seen is logged with its outcome (answered / uncertain / errored)
to `<workspace>/.headlesscode/decision-proxy.log`, so a session's full decision
history is reconstructable after the fact.

## How the proxy answers well

- **Original task text, verbatim** — never a paraphrase. Resolution order:
  1. `--task <text>` (verbatim string);
  2. `--task-file <path>` (read verbatim);
  3. the orchestrator group's `task_file` content, read from
     `<repo>/.worktrees/.orchestrator-state.json` when the watched workspace
     is one of the round's worktrees. Re-resolved per question, so a worker
     that spawns after the proxy starts is still grounded.
- **One LLM call per question, no tools** — a plain completion with a system
  prompt that demands strict JSON: `{"answer": "..."}` or `{"uncertain": true}`.
  Anything else parses as malformed → outcome errored.
- **Transient-failure resilience** (added after the pilot): retry the same
  one-shot prompt once (`MAX_PROXY_LLM_ATTEMPTS = 2`) and cap output at 4096
  tokens — a reasoning model (the default `deepseek/deepseek-v4-flash`) can
  otherwise return HTTP 200 with empty final content when its reasoning eats
  the output budget (measured 2/5 live calls empty at 400 tokens, 0/4 at 4096).
- **Stale-marker guards**: before writing, and again right after, the proxy
  verifies the marker it read is still the current one (same `askedAt`). A
  marker that vanished means the worker moved on (consumed or timed out);
  answering it then could poison the *next* escalation, because
  `escalateDecision` reads a pre-existing answer file instantly and never
  clears a stale one. The post-write guard removes the proxy's own answer if
  the marker is gone/changed in the write window (harmless if the worker
  already consumed it, required if it timed out).

## Running it

```bash
HEADLESSCODE_DECISION_PROXY=1 \
HEADLESSCODE_OPENROUTER_API_KEY=... \
npx tsx src/cli.ts decision-proxy \
  --workspace <worktree-or-workspace> \
  --task "$(cat <the session's exact task file>)"
```

- **Env-gated, default OFF**: `HEADLESSCODE_DECISION_PROXY=1` to enable
  (same opt-in convention as `HEADLESSCODE_LOCAL_EXPLORE`).
- **Model**: an explicit `--model` wins; else the `_decision-proxy` key in
  `<workspace>/.headlesscode/mode-models.json` (same `extraKeys` indirection
  as `_condensation`); else mode `code` / `_default` / `OPENROUTER_MODEL` /
  client default.
- SIGINT/SIGTERM → clean stop (exit 0, final "stopped" log line).
- The proxy is single-worktree by design for v1 — one `--workspace` per
  process; run one process per worktree if needed.

## Pilot results (this repo, real LLM, planning mode)

Baseline and proxy runs used the same deliberately-underscoped planning task
("reduce peak memory of the codebase-search index build; strictly scoped to
`src/codesearch/index.ts` + `src/codesearch/chunk.ts`; plan-only; ask me if
unsure about scope") against a fresh worktree of the headlesscode repo, mode
`planning` (whose whole job is asking clarifying questions), 2-min decision
timeout.

| metric | baseline (no proxy) | with proxy |
|---|---|---|
| time to first question | ~5 min (model explores first) | ~5.5 min |
| time `needs-decision` → `decision-answer` | never — blocked the FULL 120,000 ms (2-min timeout; **30-min production default**) then fell back to the ungrounded "must decide autonomously" error | **1.4–16.5 s** per answer (one LLM call) |
| outcome | session stalled on the question; generic fallback | session continued on grounded input (incl. a `switch_mode` planning→architect approval) |
| abstention behavior | n/a | deliberately tested: an unanswerable question (memory-budget number the task never states) → `{"uncertain": true}` → **wrote nothing in 1.4 s**, logged as uncertain |
| answer quality | n/a | calibration: 4/4 synthetic scoping questions answered correctly and specifically from the task text (1.4–3.4 s each) |

The pilot also surfaced and fixed two real issues (both in the "with proxy"
numbers above only after the fixes):

1. **Empty LLM responses** — deepseek-v4-flash intermittently returned HTTP
   200 with empty final content (reasoning consumed the output budget). Fixed
   with a one-shot retry + a 4096-token output cap; empty errors now carry a
   reasoning-vs-no-content diagnostic. Verified fail-open throughout: an
   errored/empty response wrote nothing and the session's own timeout fired.
2. **`[decision-proxy] approve` was denied by `switch_mode`** — its gate
   matched the answer text from position 0, so the audit prefix turned an
   approval into a denial. The gate now strips the prefix before the exact
   approve/deny match (the answer is still logged verbatim).

## What "the rest of the work" is (decided after the numbers)

The pilot's success criterion — decision points resolve in seconds instead of
minutes, answers are grounded on inspection, and the proxy abstains rather
than guesses when the task can't answer — is met. Candidates for follow-ups,
in rough order (none committed to yet):

1. **Multi-worktree fan-out** — today one proxy process per `--workspace`. A
   runner that watches several worktrees (or an orchestrator round) and starts
   one proxy each is mechanical; the plan said prove single-worktree first.
2. **Airunner/uwuchat integration** — "uncertain" is the signal that would
   eventually route to the real human instead of the timeout. Deliberately out
   of scope here (airunner's chat/code-mode toggle already solves its
   session-management side).
3. **An eval-test suite for calibration** — explicitly deferred in v1; the
   empty-response measurement above is the kind of thing that would justify
   one if miscalibration shows up in practice.

## What was NOT built (by design)

- No stakes/complexity-based question gating (rejected: the proxy recognizes
  its own uncertainty instead of hand-classifying question types).
- No eval-test harness (deferred; see above).
- No new marker-file protocol — reuses `.harness.needs-decision` /
  `.harness.decision-answer` exactly as they exist.
- No airunner/uwuchat wiring.
