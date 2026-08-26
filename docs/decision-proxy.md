# Decision-proxy agent — how the shipped subsystem works

The decision-proxy (`src/decision-proxy/`) is an **LLM stand-in for the
human on `ask_followup_question`** — and `switch_mode`, which shares the same
escalation primitive. This doc describes what shipped and what the live
pilot measured.

## The problem

`escalateDecision` (`src/tools/executor.ts`) writes `.harness.needs-decision`
and polls for `.harness.decision-answer` every 5s for up to
`DEFAULT_DECISION_TIMEOUT_MS` (30 minutes) before falling back to a generic,
context-free "must decide autonomously" error. Today the only way to answer
faster is a human running `scripts/headlesscode-answer.sh`. A headless
planning session (whose whole job is asking clarifying questions) either
stalls 30 minutes per question or free-runs on ungrounded defaults.

## The mechanism

A small process watches a workspace for `.harness.needs-decision` and writes
`.harness.decision-answer` — **the exact file a human writes** — grounded in
the session's ORIGINAL, verbatim task text. No change to `escalateDecision` /
`ask_followup_question` themselves: the proxy is an additive writer of the
same answer file, so the existing timeout fallback stays untouched and
remains the safety net.

Run it per worktree:

```bash
HEADLESSCODE_DECISION_PROXY=1 \
HEADLESSCODE_OPENROUTER_API_KEY=... \
npx tsx src/cli.ts decision-proxy \
  --workspace <worktree-or-workspace> \
  --task "$(cat <the session's exact task file>)"
```

- **Env-gated, default OFF**: `HEADLESSCODE_DECISION_PROXY=1` (same opt-in
  convention as `HEADLESSCODE_LOCAL_EXPLORE`).
- **Model**: explicit `--model` > `_decision-proxy` key in
  `<workspace>/.headlesscode/mode-models.json` (same `extraKeys` indirection
  as `_condensation`) > mode `code` / `_default` / `OPENROUTER_MODEL` /
  client default.
- SIGINT/SIGTERM → clean stop (exit 0, "stopped" log line).

### Three outcomes per question

1. **answered** — the task text grounds a specific answer → write
   `[decision-proxy] <answer>`. The prefix distinguishes proxy-authored
   answers from human ones in `harness.log` / the dashboard's
   `decision_answered` event — the structural audit trail (no eval-test
   suite was built; that was explicitly deferred).
2. **uncertain** — the model reports it cannot ground an answer (or no task
   text is available) → write NOTHING. The worker's poll keeps waiting and
   today's timeout fallback fires exactly as with no proxy. No
   stakes-based gating: the proxy recognizes its own uncertainty and says so.
3. **errored** — LLM failure/timeout or malformed response → write NOTHING.
   Fail closed on parse ambiguity (non-JSON is never a license to answer),
   fail open to today's behavior.

Every question is logged with its outcome to
`<workspace>/.headlesscode/decision-proxy.log`, so a session's decision
history is reconstructable after the fact.

### Answering well

- **Original task text, verbatim** — never a paraphrase. Resolution per
  question: `--task` → `--task-file` → the orchestrator group's `task_file`
  (read from `<repo>/.worktrees/.orchestrator-state.json` when the watched
  workspace is one of the round's worktrees). Re-resolved per question so a
  worker spawning after the proxy starts is still grounded.
- **One plain completion, no tools**, strict-JSON system prompt:
  `{"answer": "..."}` or `{"uncertain": true}`. Anything else parses as
  malformed → errored.
- **Transient-failure resilience**: retry the same one-shot prompt once
  (`MAX_PROXY_LLM_ATTEMPTS = 2`) and cap output at 4096 tokens. A reasoning
  model (the default `deepseek/deepseek-v4-flash-0731`) can return HTTP 200 with
  empty final content when its reasoning eats the output budget — measured
  2/5 live calls empty at 400 tokens, 0/4 at 4096. Empty errors carry a
  reasoning-vs-no-content diagnostic.
- **Stale-marker guards**: the proxy verifies the marker is still current
  (same `askedAt`) before writing, and again right after. A marker that
  vanished means the worker moved on (consumed or timed out); writing then
  could poison the next escalation (a pre-existing answer file is read
  instantly and never cleared). The post-write guard removes the proxy's own
  answer if the marker changed in the write window (harmless if already
  consumed, required if timed out).

## Live pilot results (this repo, real LLM, `planning` mode)

Same deliberately-underscoped planning task on both runs (reduce peak memory
of the codebase-search index build; strictly `src/codesearch/index.ts` +
`src/codesearch/chunk.ts`; plan-only; ask if unsure about scope), fresh
worktree, 2-min decision timeout.

| metric | baseline (no proxy) | with proxy |
|---|---|---|
| time to first question | ~5 min (exploration first) | ~5.5 min |
| `needs-decision` → `decision-answer` | never — blocked the FULL 120,000 ms (2-min test timeout; **30-min production default**) then fell back to the ungrounded autonomous-decision error | **1.4–16.5 s** (one LLM call) |
| outcome | session stalled on the question; generic fallback | session continued on grounded input, incl. a `switch_mode` planning→architect approval |
| abstention | n/a | deliberately tested: an unanswerable question (a memory-budget number the task never states) → abstained, wrote nothing in 1.4 s, logged as uncertain |
| answer quality | n/a | calibration: 4/4 synthetic scoping questions answered correctly and specifically (1.4–3.4 s each) |

Pilot fixes that shipped in the same round:

1. **Empty LLM responses** → one-shot retry + 4096-token cap + diagnostic.
2. **`[decision-proxy] approve` was denied by `switch_mode`** — the gate
   matched the answer text from position 0; it now strips the audit prefix
   before the approve/deny match (answer still logged verbatim).

## Deliberately not built

- No stakes/complexity-based question gating (rejected: recognize uncertainty
  instead of classifying question types).
- No eval-test harness for calibration (deferred; the empty-response numbers
  above are the kind of evidence that would justify one later).
- No new marker-file protocol (reuses the existing markers exactly).
- No uwuchat wiring, and no multi-worktree fan-out yet — v1 is one
  `--workspace` per process.
