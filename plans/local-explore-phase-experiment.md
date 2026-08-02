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
`num_ctx`). Flash attention + KV cache quantization
(`OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`) are now the
PERMANENT Ollama config on this machine (persisted in `/etc/init.d/ollama`,
survives reboot — re-verify this is still true in your environment, don't
assume it wasn't reverted):

| context tokens | qwen3.5:9b alone | + qwen3-embedding:8b also resident |
|---|---|---|
| 4,096 | 8.6 GB | — |
| 8,192 | 8.7 GB | 14.9 GB (coexist OK) |
| 12,288–24,576 | 8.8–9.2 GB | ~15.0–15.4 GB (coexist OK) |
| 28,672 | 9.3 GB | ~15.5 GB (coexist OK, the observed edge) |
| 32,768 | 9.5 GB | **evicts one model** (confirmed live — Ollama swaps rather than exceed VRAM) |
| 131,072 | 12 GB | n/a — exploration model alone at this size |

**Resolved via temporal separation, not a context cap.** The obvious
approach — let the exploration phase call `codebase_search` too — would
require `qwen3-embedding:8b` resident in VRAM AT THE SAME TIME as
`qwen3.5:9b` is generating, and that coexistence only holds through ~28K
context (9.3GB + 6.2GB = 15.5GB; confirmed live that 32K already evicts one
model to load the other, costing a real ~5-second reload per switch). The
project owner explicitly did not want to cap context that low. Two other
options were checked live and ruled out: no 2-bit quantization exists for
this model (checked Ollama's library directly — only full-size tags are
published), and forcing the embedding model onto CPU is not viable at all
for real indexing workloads (measured live: the identical embedding call
took 3.85s on GPU vs. **116 seconds on CPU** — a ~30x slowdown that would
turn a ~1-minute real index build for this repo's 3,756 chunks into multiple
days).

**The actual fix: `codebase_search` is NOT in the local exploration
phase's own tool set** (see "What to build" below — `read_file` and
`list_files` only). The two-phase design is already strictly sequential —
the exploration phase completes and hands off BEFORE the cloud model's turn
(and anything it triggers, including `codebase_search`) ever runs. The two
models are never actually needed in VRAM at the same instant, so there is
no real coexistence constraint to design around. This means the
exploration phase can use its full SOLO-model context ceiling instead of
the coexistence-limited one:

| context tokens | qwen3.5:9b alone (flash attn + q8_0 KV, confirmed live) |
|---|---|
| 4,096 | 8.6 GB |
| 32,768 | 9.5 GB |
| 65,536 | 10 GB |
| 131,072 | 12 GB |
| 262,144 (nominal max) | 17 GB — still doesn't fit even quantized, 86% CPU fallback, not usable |

Default the exploration phase's context budget somewhere in the
131,072-and-under range (real ~4GB headroom at that size) — re-verify these
numbers live in your environment before picking a final default, they can
shift with driver/Ollama versions.

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
potential even without file writes). Build a NEW, stricter executor variant
(or a config option on the existing one) exposing only `read_file` and
`list_files` — nothing else, not even `execute_command`, and **deliberately
NOT `codebase_search`** (see the VRAM-coexistence section above for exactly
why: `codebase_search` needs the embedding model resident at the same time
as the exploration model is generating, which is the one combination this
design avoids entirely by keeping the two phases strictly sequential — the
cloud model gets full `codebase_search` access in its own turn, unaffected).
Every other tool stubbed, matching the existing pattern.

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

---

# Results — honest evaluation, run live 2026-08-02 (this segment)

## Environment re-verification (VRAM/context table)

Re-verified live on the project owner's machine. Flash attention + q8_0 KV
cache remain the permanent Ollama config (still persisted in
`/etc/init.d/ollama`). Solo-model VRAM at each `num_ctx`, 100% GPU:

| context tokens | qwen3.5:9b alone (measured this run) |
|---|---|
| 4,096 | 8.6 GB |
| 32,768 | 9.5 GB |
| 65,536 | 10 GB |
| 131,072 | 12 GB |
| 262,144 | 17 GB — 86% CPU fallback, unusable |

The spec's table holds exactly. Default `contextTokens` stays 131,072
(~4 GB headroom on the 16 GB card). All three local phases in the eval ran
at this setting (peak model VRAM ~12 GB, no evictions, no OOM).

## Setup for the comparison

- Local phase: real Ollama `qwen3.5:9b`, defaults as shipped
  (`--local-explore`, `HEADLESSCODE_LOCAL_EXPLORE_CONTEXT_TOKENS` unset →
  131,072; `maxIterations` 15; `timeoutMs` 120 s).
- Cloud phase: real OpenRouter. The default `deepseek/deepseek-chat` and
  the `~`-alias `deepseek/deepseek-v4-flash-latest` both return
  400/404 ("not a valid model ID"), so both modes used
  `deepseek/deepseek-v4-flash-0731` (the dated, non-alias id).
- Honest cost basis: the harness's own `costUsd` falls back to the
  conservative $2/$8-per-M `FALLBACK_MODEL_PRICE` for this unlisted model
  id (≈22× inflated), so real spend is recomputed here at the model's
  OpenRouter list rates measured from `/api/v1/models` on 2026-08-02:
  $0.09/M uncached input, $0.0028/M cached input, $0.18/M output.
- 3 exploration tasks × 2 modes, identical task text. Tasks: (A) read-only
  headless executor — where created + exact tool list; (B) consecutive-error
  limit — constant, counter sites, trip/reset, `boundedFailure`; (C)
  `codebase_search` wiring + exact `IMPLEMENTED_TOOLS`/`EXECUTABLE_TOOL_NAMES`
  contents (deliberate stress case: the local model cannot call
  `codebase_search` itself, and previously drifted on this exact task).

## Numbers (real run, not impressions)

| Task | Mode | Cloud input tok | Cloud output tok | Real cost | Wall clock | Local phase |
|---|---|---|---|---|---|---|
| A | cloud-only | 82,821 | 4,032 | $0.00287 | 40 s | — |
| A | local-explore | 63,305 | 2,527 | $0.00150 | 52 s | 3 iters, ~20.3K tok, 21.7 s |
| B | cloud-only | 197,753 | 3,256 | $0.00342 | 38 s | — |
| B | local-explore | 122,017 | 3,575 | $0.00253 | 61 s | 6 iters, ~15.6K tok, 23.8 s |
| C | cloud-only | 107,201 | 3,647 | $0.00189 | 34 s | — |
| C | local-explore | 81,310 | 3,737 | $0.00146 | 54 s | 3 iters, ~20.1K tok, 19.7 s |

- **Cost: −23% to −48%** (input tokens −24% to −38%; local tokens are free).
  Total across the three tasks: $0.00818 → $0.00549 (−33%).
- **Wall clock: +12 to +23 s (+30% to +61%)** — entirely the local phase's
  own time (cold model load + inference). The cloud *portion* was equal or
  faster in local-explore mode (A 30 s vs 40 s, B 37 s vs 38 s, C 34 s vs
  34 s) — the handoff's pointer to the right files means the cloud does less
  wandering before its first useful tool call.
- **Quality: 6/6 correct**, both modes, all three tasks (verified against
  source, not just the model's word). No quality regression observed.

## Misleading-exploration audit (the important part)

The local model alone drifts on task C: 2 of 3 standalone local-phase runs
claimed `IMPLEMENTED_TOOLS` at executor.ts:1466 (actual 1458),
`EXECUTABLE_TOOL_NAMES` at prompt.ts:66 (actual 58), and claimed the
reviewer/QA executor exposes *real* `codebase_search` (it is a stub there).
Tasks A and B were essentially exact in all runs.

**However, in every CLI local-explore run the cloud's final answer was
correct** — the drift, when present in the handoff, was caught and
corrected by the cloud, never propagated to a wrong final answer (task C
local-explore gave 1458/58, matching cloud-only). The mitigations that made
this hold: the handoff header's explicit "starting point to verify, not
ground truth" framing, and the 400-char tool-result truncation marker
("re-read the file yourself to verify") which pushes the cloud to re-read
rather than trust line numbers.

Caveat: n=3 tasks × 2 modes is a small sample, all "find the code" shaped.
It does NOT establish that the mitigation always holds — especially for
tasks where the cloud might trust rather than re-read, or where the local
phase's 15-iteration bound runs out mid-exploration.

## Verdict

**Built, evaluated, not enabling by default.** Ship as opt-in (as shipped:
`--local-explore` / `HEADLESSCODE_LOCAL_EXPLORE=1`, default off, zero
behavior change when off — covered by unit test). The numbers show a real
cost win with no quality regression in sample, but the +30–60% wall-clock
increase is material on small sessions, the misleading-drift risk on line
numbers is real (measured, mitigated, not eliminated), and the sample is
too small to justify flipping a default. Re-evaluate if/when: (a) a larger
run (real task corpus, both modes) shows the cloud-corrects-drift property
holds reliably; or (b) the time cost matters less (long sessions where a
22 s pre-pass amortizes) and the user opts in per-session.

## Deviations from the spec

1. Default `deepseek/deepseek-chat` is not routable on this key (404);
   eval used `deepseek/deepseek-v4-flash-0731` instead — a same-family,
   cheaper model. Does not affect the local phase; the harness default is
   unchanged.
2. The eval harness header references `plans/local-exploration.md`; the
   actual file is `plans/local-explore-phase-experiment.md` — reference
   fixed in `scripts/local-explore-eval.mjs`.
3. No plan-doc changes to the shipped behavior: default stays off, per the
   verdict above.
