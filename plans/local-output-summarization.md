# Local-model compression of oversized tool outputs — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. The
project owner has Ollama installed locally (RTX 5080, 16GB VRAM, 32GB system
RAM) and wants to explore using a local model for narrow, low-risk support
roles — NOT for tool-call decision-making (that stays on the cloud model).
This task is explicitly scoped as an experiment with a real, honest
evaluation, not a guaranteed win to ship no matter what you find.

Match this project's established style: no test framework (plain `tsx`-run
test files, `All N tests passed` trailer); `npx tsc --noEmit` and `npm test`
must stay green; re-run every e2e suite under `scripts/e2e*/run.sh`.

## The problem / motivation

`src/tools/executor.ts`'s `MAX_RESULT_CHARS` (30,000) truncates any tool
result before it reaches the model — a blunt cutoff, not a summary. A huge
`execute_command` stdout (e.g. a verbose test run, a large `npm install`
log, a big `grep -r` result) gets hard-truncated, discarding whatever was
past the cutoff even if it contained the one relevant line. The idea: before
truncating, have a small LOCAL model (fast, zero marginal cost, already
available via Ollama) produce a much shorter summary/extraction that
preserves the actually-relevant content, instead of naively cutting at a
fixed character count.

This is deliberately a NARROW use of a local model: it compresses text, it
does not decide what to read/write/run — the cloud model still makes every
actual coding decision. This is the safer half of the "use Ollama" idea the
project owner floated; do not expand its scope to tool-call routing.

## Before you build anything — evaluate honestly, report honestly

This task's value is NOT guaranteed. A bad summary is worse than a blunt
truncation, because a blunt truncation is at least honest about what's
missing, while a bad summary can confidently omit the one relevant detail
and mislead the cloud model. Before committing to shipping this:

1. Pick 1-2 candidate small models available via Ollama on this hardware
   (7-8B class is a reasonable starting point for a 16GB-VRAM card — you are
   not required to guess exactly which one is "best," pull a couple of
   real, currently-available options and actually compare them, don't
   assert a winner without testing).
2. Construct a handful of realistic large-output fixtures (a long test-run
   log with one real failure buried in it, a big `grep` result with one
   relevant hit among many noise hits, a large `npm install` log with a
   warning buried in it) and compare: local-model summary vs. blunt
   truncation vs. the ORIGINAL full content. Does the summary actually keep
   the relevant needle? Be willing to conclude "this doesn't work reliably
   enough yet" and say so plainly in your report rather than shipping a
   feature that looks done but degrades output quality.

## What to build (if your evaluation supports it)

**1. A local summarization client.** New `src/tools/output-summarizer.ts` (or
similar) using plain `fetch` against Ollama's local chat/generate API
(verify the real endpoint/request shape the same way `plans/local-
embeddings-ollama.md` verifies the embeddings one — do not assume, these
are different Ollama endpoints). Takes raw tool output + a size budget,
returns a compressed version.

**2. Wire into the executor, opt-in and bounded.** Only engage when a tool
result would otherwise exceed `MAX_RESULT_CHARS` (don't summarize small,
already-fine results — that's pure added latency/risk for no benefit). New
env var (e.g. `HEADLESSCODE_LOCAL_SUMMARIZATION=1`, default OFF — this must
not change default behavior for anyone not opting in) gating the whole
feature. When on, the summarizer runs; on ANY failure (Ollama unreachable,
timeout, malformed response), fall back to today's blunt-truncation
behavior — never let a broken local model turn a tool result into an error
or block the session. This must be as close to zero-risk to the main loop
as the checkpoint/memory "non-fatal" pattern already established elsewhere
in this codebase (grep `loop.ts` for "non-fatal" to match the idiom).

**3. Make the compression visible, not silent.** The tool result the model
sees should make clear it was summarized (e.g. a header line: "[Output
summarized by local model — original was N chars, see below]") so the
cloud model (and a human reading `harness.log`) knows this isn't the literal
raw output — same transparency principle as the read-cache's "[cache]"
prefix.

## What NOT to do

- Do not use this for anything the cloud model needs verbatim for a
  decision with real consequences (e.g. do not summarize a diff you're
  about to apply, or file content being edited) — this is specifically for
  large, mostly-noisy command output, not code content.
- Do not make this the default — opt-in only, and only after your own
  evaluation gives you real confidence it helps more than it risks. If your
  evaluation is inconclusive or negative, say so and do NOT wire it on by
  default just because the task asked you to build something.
- Do not touch `MAX_RESULT_CHARS`'s existing blunt-truncation behavior for
  anyone who doesn't opt in.

## Tests

- `src/tools/__tests__/output-summarizer.test.ts`: request/response
  handling against a fake local Ollama server (no real Ollama required for
  the unit suite).
- A test proving the opt-in env var actually gates the feature (off by
  default = today's exact truncation behavior, unchanged).
- A test proving Ollama-unreachable/malformed-response falls back to blunt
  truncation cleanly, not an error or a hang.
- A test proving small results (under the threshold) are never sent to the
  summarizer at all.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes (with the
   feature OFF by default — confirm nothing changed for existing suites).
4. Your honest evaluation from the "before you build anything" section,
   with real fixture examples and real model output, not hypothetical.

## What to report back

- Which model(s) you evaluated and your honest verdict on summary quality
  — including if the verdict is "not good enough to ship as default,
  built but recommend leaving it off."
- Confirmation of tsc/test/e2e results.
- Whether the manual Ollama smoke test ran for real, and why/why not.
- Any deviation from this spec, and why.
