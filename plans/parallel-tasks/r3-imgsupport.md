# Round-level instructions (from the orchestrator) — read FIRST

You are working autonomously in an isolated git worktree on your own branch.
The full task spec for your assignment follows below this preamble; it is
binding. In addition, these round-level instructions apply:

## Mandatory: commit your own work before you finish (non-negotiable)

Workers in recent rounds repeatedly finished with their changes sitting
UNCOMMITTED in the worktree — no real commit on the branch. That must not
happen this round. Before you call `attempt_completion`:

1. `git add` all your changes (including new files) and
   `git commit -m "<concise message>"` on your branch.
2. Verify a REAL commit landed by running `git log --oneline -1` — you must
   see your commit's hash on your branch. `git status` alone is NOT proof
   of a commit; the orchestrator will independently check `git log` on your
   branch and will treat the task as incomplete without it.

Do NOT merge to master, do NOT push, do NOT open a PR — the orchestrator
handles review and merging after you finish.

## Model and iteration budget

- Model: deepseek/deepseek-v4-flash, plain code mode.
- HEADLESSCODE_MAX_ITERATIONS=150 — you have up to 150 loop iterations.
- If you reach the iteration cap having made steady progress with zero
  real errors: RESUME (continue from where you are), do not restart the
  task from scratch. Wrap up cleanly, commit, and report exactly what
  remains if anything is unfinished.
- On any REAL error (persistent tool failure, auth failure, verification
  failure you cannot resolve): stop, commit whatever is in a working state,
  and report the error explicitly rather than papering over it.

## Verification bar (repo-wide requirement)

- `npx tsc --noEmit` must be clean.
- `npm test` must pass in full (plain tsx-run test files, no framework;
  new test files must be added to the `test` script in package.json).
- If you touch `src/orchestrator/`, `src/watcher/`, or `scripts/*.sh`,
  also re-run the relevant suites under `scripts/e2e*/run.sh`.

## Never write to /tmp

Scratch/temporary files go under `<workspace>/.headlesscode/scratch/`, never
`/tmp` (outside-workspace writes are rejected in this environment).

## Reporting

Follow the "What to report back" section of your task spec below. Include
the output of `git log --oneline -1` (your commit hash) in your final
report so the orchestrator can confirm it landed.

========================================================================
# TASK SPEC (verbatim from the plan file)
========================================================================
# Image support — a cheap-but-competent cloud vision model describes images to text

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. The
pinned primary model (`deepseek/deepseek-v4-flash`) cannot process images at
all, and there is currently **no image path through this harness whatsoever**
— confirmed by reading the code, not assumed: `ChatMessage.content`
(`src/engine/types.ts`) is `string | null` only, no multimodal content-array
shape exists anywhere in this project's types, and `ToolResult.content` is
likewise text-only. `src/tools/browser/tool.ts`'s `screenshot` action already
writes a real PNG to disk and tells the model to "read it back with
`read_file` if your model supports images" — **that instruction is currently
a dead end**: `read_file`'s `ToolResult` is text-only too, so there is no
actual mechanism today for image bytes to reach any model in this system.
This task builds that mechanism for the first time.

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh`.

## The chosen approach — cloud vision-captioning, NOT local, NOT a core type change

Two designs were considered and one was explicitly rejected by the project
owner:

- **Rejected: a local Ollama vision model.** This project has real, live
  hardware-constraint precedent (`plans/local-explore-phase-experiment.md`)
  showing local models competing for VRAM with each other; a vision model
  would be a third contender. More importantly, the project owner
  explicitly redirected away from this: **use OpenRouter (cloud), not
  local, for this feature.**
- **Chosen: a narrow, isolated cloud vision-captioning utility** — the SAME
  pattern already established and validated by `local-output-summarization`
  and `local-explore-phase-experiment`: a small, separate call outside the
  main agent loop's request path, whose only job is to turn an image into a
  text description, which then flows into the existing text-only
  `ToolResult`/`ChatMessage` pipe completely unchanged. **Do not modify
  `ChatMessage.content`'s type or add a multimodal content-array shape to
  the core engine types** — that would be a much larger, more invasive
  change (every `LlmClient`, every provider integration, the whole request/
  response pipeline) for no benefit this project needs right now. The
  captioning call is self-contained: it builds its OWN OpenAI-compatible
  multimodal request (image_url content part) directly against OpenRouter,
  gets back a text description, and that's the only thing that touches the
  rest of the system.

## Model choice — do NOT hardcode a guess, run a real evaluation

The project owner's explicit instruction: **"the absolute lowest cost model
on openrouter, but it also has to be competent... we don't want to sacrifice
quality for cost - or at least we need to be balanced in this sacrifice."**
This is a real evaluation requirement, not a preference to guess at.

Real OpenRouter pricing pulled live 2026-08-02 (verify again yourself before
finalizing — pricing changes; do not trust these numbers as gospel, they are
a starting shortlist) for models whose `architecture.input_modalities`
includes `"image"`, cheapest first:

```
qwen/qwen3.7-flash              in:$0.030/M out:$0.130/M ctx:1,000,000
openai/gpt-5-nano                in:$0.050/M out:$0.400/M ctx:400,000
google/gemma-3-4b-it             in:$0.050/M out:$0.100/M ctx:131,072
google/gemma-3-12b-it            in:$0.050/M out:$0.150/M ctx:131,072
amazon/nova-lite-v1              in:$0.060/M out:$0.240/M ctx:300,000
qwen/qwen3.5-flash-02-23         in:$0.065/M out:$0.260/M ctx:1,000,000
mistralai/mistral-small-3.2-24b-instruct  in:$0.075/M out:$0.200/M ctx:256,000
google/gemma-3-27b-it             in:$0.080/M out:$0.450/M ctx:262,144
```
(Free-tier vision models also exist — do not default to one; this project's
own established skepticism about relying on free-tier availability/rate
limits for anything that needs to actually work applies here too.)

**Build the evaluation, not just the feature.** Assemble a small set of real
test images that matter for this project's actual use case — at minimum:
a real `browser_action` screenshot of a page with a visible bug/error (the
primary intended use case), a screenshot with meaningful text/UI detail a
description needs to preserve accurately, and one image with fine detail
that's easy to describe vaguely but hard to describe usefully (tests
whether a cheap model gives a lazy generic caption vs. an actually useful
one). For each image, run description generation against at least 3
candidates spanning the price range above (e.g. `qwen3.7-flash` as the
cheapest, one mid-tier, `gemma-3-27b-it` or similar as a quality anchor).
Compare: does the description contain enough real, correct detail that
`deepseek/deepseek-v4-flash` (fed ONLY the text description, not the image)
could actually act on it correctly (e.g., correctly identify what's visually
wrong on a broken page)? Real cost per image at each candidate's pricing.
Pick a default based on this evidence, and say explicitly why — "cheapest
that didn't produce a materially worse description than the quality anchor"
is a reasonable bar, but justify it with the real comparison, not
assumption. If the cheapest candidate is good enough, use it — if it's not,
say so and justify the more expensive default, per the project owner's own
"don't sacrifice quality" instruction.

## What to build

### 1. `src/vision/describe.ts` — the captioning utility

A function `describeImage(imagePath: string, options?): Promise<string>`
that reads the image file, base64-encodes it, and makes a direct HTTP call
to OpenRouter's chat completions endpoint with a multimodal message
(standard OpenAI-compatible shape: `content: [{type: "text", text: "..."},
{type: "image_url", image_url: {url: "data:image/png;base64,..."}}]`) using
the chosen default model (see above), asking for a detailed, factual
description (prompt engineering is part of this task — write a system
prompt that asks for concrete, actionable detail: visible text, layout,
error messages, colors/state that matter, not a vague generic caption).
Returns the description text. This is a standalone module — it does NOT go
through `LlmClient`/`OpenRouterClient` (those are typed around the
text-only `ChatMessage` shape); make its own minimal HTTP call, matching
how `local-explore.ts`'s `OllamaLocalChatClient` is similarly a standalone,
narrow client outside the main abstraction, not shoehorned into it.

Config: `HEADLESSCODE_VISION_MODEL` env var (default: whatever your
evaluation above picks), reusing the same `HEADLESSCODE_OPENROUTER_API_KEY`. Real $ cost
per call — wire this into the existing budget/usage tracking
(`src/budget/`, `.headlesscode/usage/*.jsonl`) the same way regular LLM
calls are recorded, not as an untracked side channel — a coding session
that generates several screenshots and captions each one should show that
cost in its real total, not hide it.

### 2. Wire it into `browser_action`'s screenshot result

`src/tools/browser/tool.ts`'s screenshot action currently returns "read it
back with read_file if your model supports images" — replace this dead-end
instruction. After saving the PNG, call `describeImage` on it and include
the real description directly in the `ToolResult` content (alongside the
file path — keep the path too, in case a future feature does add real
multimodal support and wants the raw file). This is the task's primary,
already-connected use case: screenshots become genuinely useful to the
model for the first time.

### 3. A general-purpose `describe_image` tool

For any image already in the workspace (not just fresh screenshots) — e.g.
future dashboard-uploaded images, or images already present in a repo the
harness is working in. Schema: `{path: string}` (relative to workspace
root, reuse `resolveWithinWorkspace`'s existing path-safety guard — don't
re-derive it). Register it in `code` mode's tool set
(`createHeadlessExecutor` — follow the precedent of how `codebase_search`/
codeintel tools were added recently). Returns the description the same way.

### 3a. `describe_image` needs a real usage nudge — this is not optional

Real evidence from this project's own live sessions: tools shipped with only
a good schema description and no rules-file mention get essentially zero
adoption (`outline`/`go_to_definition`/`find_references`/`import_graph`
landed with solid descriptions and were used 0 times across three separate
live sessions, except `outline` at 7 calls total). `codebase_search`, by
contrast, got real repeated adoption specifically because its own task
required adding explicit "try this before X" guidance to
`.roo/rules-code/rules.md` AND verifying live that the guidance actually
changed behavior. This project's `.roo/rules/rules.md` now codifies this as
a standing requirement ("A new tool is not done until something tells a
model to reach for it") — read that section before finishing this task.
Concretely: add a short, scannable entry to `.roo/rules-code/rules.md`
(match the existing compact bullet-list format used for the code-intel
tools' section — do not write a long prose paragraph) telling the model
when to reach for `describe_image` (e.g., after a `browser_action`
screenshot if it wasn't already auto-described per item 2 above, or when a
task references an image already in the workspace), and confirm in a real
session that the model actually uses it when relevant.

### 4. Update the now-stale comment/description

`src/tools/browser/tool.ts`'s header comment and the screenshot tool's own
description text both currently describe the "read it back if your model
supports images" dead end — update both to describe what actually happens
now (screenshot → real text description, no raw image ever reaching the
main model).

## What NOT to do

- Do not modify `ChatMessage`/`LlmRequest`/`LlmResponse` core types to add
  multimodal content-array support — out of scope, unnecessary for this
  design, and a much bigger change than this task calls for.
- Do not default to a local Ollama vision model — explicitly rejected
  direction for this task.
- Do not hardcode a model choice without running the real evaluation above
  and justifying it with evidence.
- Do not leave image cost untracked — it must flow into the same budget/
  usage accounting as every other LLM call.
- Do not build dashboard image-upload UI in this task — that's a real,
  separate, larger piece (file upload handling, session-launch UI changes)
  that this task's `describe_image` tool sets up for but doesn't itself
  need to build. Flag it as a natural follow-up in your report, don't
  build it now.

## Tests

`src/vision/__tests__/describe.test.ts`:
- `describeImage` against a fake HTTP server returning a scripted
  multimodal response — assert the request shape (base64 image_url content
  part) and that the description text is extracted correctly.
- Cost/usage recording: assert a captioning call shows up in the same
  usage-tracking path as a regular LLM call, with real token/cost numbers,
  not a hardcoded stub.

`src/tools/browser/__tests__/` (extend existing): screenshot action now
returns a real description in its result, not the old "read it back"
instruction text — assert against a fixture/fake vision response.

`src/tools/__tests__/describe_image.test.ts`: the new tool round-trips
correctly, rejects a path outside the workspace, handles a missing file
with a clear error.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. The model evaluation above, run for real against the live OpenRouter API
   (you have a real key available) — real images, real candidate models,
   real cost numbers, real quality comparison. If you cannot run it for
   real, say so plainly and explain exactly why, per this project's
   standing "honest evaluation" convention — do not claim it ran if it
   didn't (this is the same discipline `activate-update-todo-list`'s rework
   cycle is currently being held to after a false "no API access" claim —
   the project owner will check the evidence).
5. Manual: run a real `browser_action` session that takes a screenshot of a
   page with something visually wrong on it, confirm the resulting
   description is accurate enough that the coding model correctly diagnoses
   the issue from the text alone. Quote the real description and the
   model's resulting diagnosis in your report.

## What to report back

- Files changed/added.
- The full model evaluation: candidates tested, real per-image cost, and
  your quality comparison with concrete examples (quote actual
  descriptions side by side for at least one test image).
- Your chosen default model and why, addressing the project owner's
  explicit "balanced, don't sacrifice quality for cost" instruction
  directly.
- Confirmation of tsc/test/e2e results.
- Confirmation cost/usage tracking actually captures captioning calls (real
  `usage/*.jsonl` evidence, not just "I wired it up").
- The real screenshot-to-description-to-diagnosis smoke test result.
- Any deviation from this spec, and why.
