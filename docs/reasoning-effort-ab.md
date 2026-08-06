# Reasoning-effort A/B — deepseek/deepseek-v4-flash (issue #30)

Date: 2026-08-06. Live against the real OpenRouter API, model
`deepseek/deepseek-v4-flash`, branch `issues/w7-2026-08-05`, code at commit
`f51241f` (the step-1 config surface, PR #54).

This document is the phase-1 deliverable of issue #30's experiment: the static
A/B measurement of graded reasoning effort (steps 2–4 of the issue). The
config surface (step 1) is delivered in PR #54; this report is the
measurement that config surface was built to enable.

## TL;DR / conclusion (issue step 4)

**Do not change the default.** On a well-scoped routine edit task, run 6 times
(2 × unset / `high` / `xhigh`, everything else identical), higher effort
produced **no iteration reduction and identical QA outcomes** while costing
slightly more and running slightly slower. The issue's step-4 bar — "if higher
effort meaningfully cuts iterations/wall-clock at a cost delta smaller than the
time saved is worth, make it the new default" — is **not met**. The default
(unset) stays; `_reasoning_effort` / `$HEADLESSCODE_REASONING_EFFORT` remain
available for anyone who wants to dial it.

Two secondary findings:

1. **The issue's "undeclared default" premise is refined.** The models
   endpoint declares `reasoning.default_effort: "high"` for this model, but a
   live probe with the `reasoning` object **absent** (what the harness sends
   today) returns **no reasoning trace** and the cheapest/fastest completion —
   the absent field behaves like the minimal-effort path, not a declared
   `high` default. The listing's `default_effort` describes the model's
   `reasoning_effort` parameter, not the behavior of an absent `reasoning`
   object.
2. **The accepted wire set is confirmed live.** `reasoning: { effort: "low" |
   "medium" | "high" | "xhigh" }` all return HTTP 200 on
   deepseek/deepseek-v4-flash; the harness's `max` → `xhigh` normalization
   matches the provider's normalized set.

---

## Method

### Part A — live wire probe (fixed prompt, single completion each)

Three (later five) identical chat-completions against the real API, differing
only in the `reasoning` field. Verifies the accepted set (the reviewer-flagged
gap: "the exact accepted set on OpenRouter for deepseek-v4-flash was not
live-probed (needs a real key)") and quantifies the per-level cost/latency
delta on a pure-reasoning prompt.

Prompt A (effort scaling): *"Spell the word 'strawberry' letter by letter and
count how many 'r' letters it contains. Then do the same for 'raspberry'."*
`max_tokens: 1024`, `include_reasoning: true`.

| wire form | HTTP | completion tokens | reasoning trace | cost (est.) | latency |
| --- | --- | --- | --- | --- | --- |
| `(unset)` | 200 | 148 | none | $0.000030 | 2.9 s |
| `reasoning:{effort:"high"}` | 200 | 227 | 447 chars | $0.000044 | 6.3 s |
| `reasoning:{effort:"xhigh"}` | 200 | 519 | 1373 chars | $0.000103 | 13.4 s |

Prompt B (full accepted set): *"What is 17 * 23?"* — `unset`, `low`,
`medium`, `high`, `xhigh` all returned HTTP 200 (no 4xx anywhere; `max` maps
to `xhigh` in the harness and is covered by that case).

### Part B — harness A/B (the issue's steps 2–4)

- **Task** (identical string every run): fix two seeded bugs in
  `src/tools.js` of a synthetic fixture repo — `greet(name)` returns `""`
  instead of `"Hello, " + name`, and `sumPositive(nums)` is off by one —
  so that `node src/tools.test.js` exits 0; the test file is the contract and
  must not be modified.
- **Fixture**: one git repo, one pinned commit (`790f517`), built by
  `.headlesscode/scratch/ab-fixture.sh`. Each cell gets a **fresh worktree of
  that same commit** — "same task, same repo state" holds by construction.
  The seeded bugs make the test fail (exit 1) before any run.
- **Cells**: `unset` (no effort env — today's behavior) vs
  `HEADLESSCODE_REASONING_EFFORT=high` vs `=xhigh`, × 2 runs each = 6 sessions.
- **Everything else constant**: `--mode code`, `--max-iterations 25`,
  `--max-cost-usd 0.25`, `--no-checkpoints`, per-cell `HEADLESSCODE_DATA_DIR`
  (isolates checkpoints/cost-history), same `OPENROUTER_MODEL`
  (`deepseek/deepseek-v4-flash`), same CLI invocation, sequential execution
  (no rate-limit contention).
- **Metrics** (from the harness's own usage JSONL
  `<worktree>/.headlesscode/usage/<sessionId>.jsonl` + the `[budget]` line):
  iteration count, wall-clock, cost, tokens; QA = CLI exit code, test exit
  code, diff-vs-base, whether the test file was touched.

---

## Results — Part B (real run output)

| cell | iterations | input tok | output tok | cached tok | cost USD | wall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| unset-1 | 6 | 82636 | 1007 | 69376 | 0.002333 | 13.6 s |
| unset-2 | 5 | 68018 | 767 | 54912 | 0.002203 | 10.2 s |
| high-1 | 6 | 82249 | 919 | 68992 | 0.002306 | 12.0 s |
| high-2 | 6 | 83540 | 1043 | 70016 | 0.002381 | 13.0 s |
| xhigh-1 | 6 | 82730 | 1035 | 69504 | 0.002336 | 13.5 s |
| xhigh-2 | 6 | 82923 | 1072 | 69504 | 0.002373 | 14.1 s |

Means:

| condition | iterations | cost USD | wall | output tok |
| --- | ---: | ---: | ---: | ---: |
| unset | **5.5** | **0.002268** | **11.9 s** | 887 |
| high | 6.0 | 0.002344 | 12.5 s | 981 |
| xhigh | 6.0 | 0.002355 | 13.8 s | 1054 |

QA (all 6 cells, identical): CLI exit 0; `node src/tools.test.js` exit 0
("tools tests passed"); diff vs base = `src/tools.js` only, 2 insertions /
2 deletions; `src/tools.test.js` untouched; the agent committed its fix in
each cell.

The budget tracker resolved live pricing each run:
`{"model":"deepseek/deepseek-v4-flash","input":0.14,"output":0.28,"cacheRead":0.0028}`
(per-1M-token USD as the harness's cost basis).

---

## Analysis

- **Iterations: no reduction.** 5.5 (unset) vs 6.0 (high/xhigh) — the unset
  cells averaged *fewer* iterations; with per-cell counts of 5–6 this is
  session noise, not a signal. Higher effort did not make the agent converge
  faster on a well-scoped task that is already near-optimal at 5–6 iterations.
- **Cost: +3.4% / +3.8% vs unset.** The dial's effect on raw completions is
  real (Part A: xhigh ≈ 3.4× the completion cost of unset), but a harness
  session's cost is dominated by the **input side** — ~84% of session cost is
  the ~83k input tokens (69k cache-read at the cheap rate), which is identical
  across conditions. The reasoning-token delta lands on ~1k output tokens and
  moves total cost by ~$0.0001 — a rounding error.
- **Wall-clock: +4.7% / +16%.** Same story: reasoning adds latency per call
  (Part A: 2.9 s → 6.3 s → 13.4 s per completion on a pure-reasoning prompt),
  but in a 6-iteration tool-calling session the total moves from 11.9 s to
  13.8 s.
- **QA outcome: identical at every level.** All six cells produced the same
  minimal correct fix with a green test and a clean commit. No quality
  difference to pay for.

### Why the harness A/B shows so much less than the probe

The probe isolates the dial on a pure-reasoning completion, where effort
directly scales reasoning-token output. In a harness session the output stream
is dominated by tool calls (JSON), the reasoning trace is a small side
channel, and the input+cache cost — invariant to effort — dominates the total.
So the dial's cost/latency effect is diluted to a rounding error, and on a
task the model already solves optimally there is no iteration saving to trade
for it.

---

## Decision (issue step 4)

**Keep the default unset** — no `_reasoning_effort` default is set for
worker/review/QA modes. The measured data does not meet the issue's bar:
higher effort cut nothing and cost slightly more. The config surface from
PR #54 remains the mechanism for anyone who wants a per-mode/per-task effort
level, and the `--dry-run` + startup validation make a misconfigured value
fail loudly rather than silently skew a comparison.

## Caveats / follow-ups

- **n = 2 per condition, one task, one mode (`code`), one model.** The task
  was a small, well-scoped edit the model solves near-optimally even unset; a
  harder/more ambiguous task (or a review/QA session, which the issue itself
  speculated may benefit more) is untested and could show a different picture.
  This report's claim is scoped to routine, well-scoped worker edits.
- The model's `reasoning_effort` parameter documents `default_effort: "high"`,
  but an absent `reasoning` object empirically takes the minimal-effort path
  (no reasoning trace) — see finding 1 above. If OpenRouter ever changes the
  absent-field behavior, the harness's unset default would move with it; that
  is exactly the non-determinism the issue worried about, and it is one
  argument for an *explicit* `_reasoning_effort` where determinism matters —
  but the measured numbers do not justify forcing one globally.
- A phase-2 idea from the issue (adaptive effort selection) remains
  speculative; nothing in this data argues for it, since the effort dial did
  not measurably change outcomes on the task tested.
