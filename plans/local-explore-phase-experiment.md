# Local-model read-only exploration phase — an honestly-evaluated experiment, not a mandate to ship

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. The
project owner has a local machine with Ollama, an RTX 5080 (16GB VRAM), and
has pulled `qwen3.5:9b` specifically for this (Q4_K_M quantization by
default — already 4-bit, confirmed via `ollama show qwen3.5:9b`; do not
re-quantize or pick a different quant without a real reason). This is
explicitly framed as an **experiment with a real, honest evaluation** — like
`plans/local-output-summarization.md` earlier, which built something, found
real problems with it via rigorous testing, and correctly shipped it OFF by
default. Do the same discipline here: build it, measure it for real, report
honestly even if the honest answer is "not good enough yet."

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh`.

## Why this is scoped as a two-phase handoff, not "route tool calls to a local model"

Read this section before designing anything — it's the actual spec, not
background color.

The harness makes ONE tool-call decision per model turn, as part of a
single chat-completion response (`HeadlessSession.run()`,
`src/engine/loop.ts`) — there is no clean way to hand off *individual*
tool-call decisions between two live models mid-turn without a much deeper
rearchitecture than this task is scoped for. Attempting that would also
reintroduce exactly the risk this project has spent real effort steering
away from: a local model making an in-the-moment decision inside the same
turn a cloud model would otherwise make, with no clean boundary for where
one model's judgment ends and the other's begins.

**Real VRAM/context measurements taken live on the project owner's actual
hardware, 2026-08-02** (`ollama ps` after loading `qwen3.5:9b` at increasing
`num_ctx`):

| context tokens | VRAM (100% GPU) |
|---|---|
| 4,096 | 8.6 GB |
| 8,192 | 8.8 GB |
| 32,768 | 9.9 GB |
| 65,536 | 11 GB |
| 131,072 | 14 GB |

The model's nominal max context (262,144 per `ollama show`) would almost
certainly exceed the 16GB card entirely — extrapolate the growth rate
yourself before assuming otherwise. **The real, safe operating ceiling on
this hardware is roughly 32K-64K tokens, not the model's headline number.**
This is a hard constraint on the design, not a tuning nicety: whatever you
build must default to a context budget inside this range and must not
silently let a local session's history grow past what the hardware can
actually hold. Re-verify these numbers yourself live before relying on
them — Ollama/driver versions can change this.

**The design this leads to**: a bounded **local exploration phase** that
runs BEFORE the cloud model's turn, using a read-only, side-effect-free tool
set, for a capped number of iterations and a capped context budget. Once
the local phase concludes (either it decides it has enough context, or it
hits its iteration/context cap), its accumulated findings are folded into
the cloud model's initial context as a synthetic message, and the cloud
model takes over completely for the rest of the session — implementation,
further exploration if it needs more, everything. The local model never
touches `write_to_file`/`apply_diff`/`search_replace`/`edit_file`/
`execute_command`/`attempt_completion` — this phase is pure information-
gathering, nothing else.

## What to build

### 1. An even-narrower tool set than the existing read-only executor

`src/tools/executor.ts` already has `createReadOnlyHeadlessExecutor` (used
by reviewer/QA), but it includes `execute_command` — that's too permissive
for this use case (arbitrary command execution has real side-effect
potential even without file writes). Build a NEW, stricter executor
variant (or a config option on the existing one) exposing only `read_file`,
`list_files`, and `codebase_search` — nothing else, not even
`execute_command`. Every other tool stubbed, matching the existing pattern.

### 2. A local exploration session

New module (e.g. `src/engine/local-explore.ts`): runs a loop structurally
similar to `HeadlessSession` but deliberately simpler — no budget tracker
needed (local calls are free), no checkpoints (nothing gets written), bounded
by BOTH an iteration cap (e.g. default 15 — pick a real default and justify
it) AND the context budget from the table above (track estimated tokens the
same way `src/engine/condense.ts`'s `estimateMessageChars` does, stop before
exceeding the configured ceiling, not after). Uses a local Ollama chat-
completions client — verify Ollama's real tool-calling wire format live
(don't assume it matches OpenRouter's exactly; `qwen3.5:9b`'s own capability
list includes `tools`, confirmed via `ollama show`, but the request/response
shape may differ — check against a real call before writing the client).

Termination conditions for the local phase, all of which must produce a
clean handoff, never a hang or a crash:
- The model calls `attempt_completion` early (signals "I have enough,
  hand off now") — even though this phase is read-only, keep
  `attempt_completion` available as the explicit "I'm done exploring"
  signal, distinct from actually completing the task.
- Iteration cap reached.
- Context budget reached.
- Any local-model error (Ollama unreachable, malformed response, etc.) —
  **must fail open**: abandon the local phase entirely and fall straight
  into today's cloud-only behavior, never abort the session. This mirrors
  the non-fatal-degradation idiom already used for memory/checkpoints in
  `loop.ts` — a broken experimental feature must never be able to break a
  real session.

### 3. The handoff

Fold the local phase's exploration transcript (or a condensed summary of
it — your call, but if you summarize, reuse `src/engine/condense.ts`'s
existing summarization machinery rather than writing a new one) into the
cloud session's initial context as a clearly-labeled synthetic message
(e.g. "Local exploration phase found: ..."), analogous to how
`buildCondensedMessage` already labels condensed history. The cloud model
must be able to tell this content came from a preliminary local pass, not
from its own prior turns — label it honestly, don't disguise it as the
cloud model's own earlier work.

### 4. Wiring + opt-in

New CLI flag/env var (e.g. `--local-explore` /
`HEADLESSCODE_LOCAL_EXPLORE=1`, off by default — same pattern as
`HEADLESSCODE_LOCAL_SUMMARIZATION`). When enabled, `HeadlessSession` runs
the local exploration phase before its first real iteration, folds in the
handoff message, then proceeds exactly as today. When disabled (default),
zero behavior change — confirm this with a test, not just by reading the
code.

## Before enabling anything — the honest evaluation

This is the actual point of the task, same rigor as
`plans/local-output-summarization.md`'s evaluation:

1. Pick 2-3 realistic exploration tasks (e.g. "where is X handled and how,"
   similar in spirit to the real `codebase_search`-activation smoke test
   from earlier today) and run BOTH modes for real: local-explore-then-
   cloud vs. cloud-only, on the identical task.
2. Compare, with real numbers, not impressions: total cost (should drop,
   since the exploration tokens are free), total wall-clock time (may
   INCREASE — local inference + a cold local-model load has real latency;
   quantify it), and — most important — whether the cloud model's
   EVENTUAL output quality/correctness differs at all between the two
   modes. A cost win that comes with a quality regression is not a win.
3. Specifically check: does the local model's exploration ever mislead the
   cloud model (wrong file, wrong conclusion, something the cloud model
   would have found faster itself)? If the handoff summary is actively
   wrong sometimes, quantify how often, the same way the summarization
   evaluation quantified its needle-preservation failure.
4. Be willing to conclude "built, evaluated, not enabling by default yet"
   if the numbers don't clearly support it — that is a legitimate, useful
   outcome for this task, not a failure to deliver.

## What NOT to do

- Do not attempt to route individual tool-call decisions within a single
  cloud-model turn to a local model — explicitly out of scope, see the
  architecture section above.
- Do not let the local phase have `execute_command` or any write tool.
- Do not let the local phase's context grow past the measured safe VRAM
  ceiling — this is a hard constraint, not a soft default to be casually
  raised.
- Do not make this the default — opt-in only, and only ship it enabled if
  your own evaluation gives real, quantified confidence.
- Do not let any local-phase failure (Ollama down, bad response, model not
  pulled) abort or degrade a real session — fail open to today's behavior.

## Tests

- `src/engine/__tests__/local-explore.test.ts`: iteration cap enforcement,
  context-budget cap enforcement (construct a fixture that would exceed the
  budget, assert the phase stops before exceeding it), early-`attempt_completion`
  termination, and Ollama-unreachable fail-open behavior (assert the
  session proceeds normally with zero local-phase content, not an error).
- A test proving the handoff message is clearly labeled and distinguishable
  from real cloud-model history.
- A test proving `HEADLESSCODE_LOCAL_EXPLORE` unset/false is a complete
  no-op — zero local calls, zero behavior change from today.
- A test for the narrower tool set: confirm `execute_command` and every
  write tool are genuinely unavailable in the local phase's executor, not
  just unused.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes (feature OFF by
   default — confirm nothing changed for existing suites).
4. The honest evaluation from the section above, run for real against the
   real local Ollama instance and (if you have real API access) a real
   cloud session — quantified numbers, not impressions.

## What to report back

- Real VRAM/context numbers you observed (confirm or correct the table
  above for the actual environment you ran in).
- The full honest evaluation: cost delta, wall-clock delta, quality/
  correctness comparison, any misleading-exploration incidents found.
- Your verdict: ready to enable by default, needs more work, or not worth
  pursuing further — with the reasoning, not just the verdict.
- Confirmation of tsc/test/e2e results.
- Any deviation from this spec, and why.
