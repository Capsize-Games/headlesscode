# Cloud vision captioning (image → text)

## What this is

This harness has exactly one image path, and it is deliberately narrow: a
cloud vision model turns an image into a **text description**, and only that
text ever reaches the coding model. `ChatMessage.content` and
`ToolResult.content` stay `string`-only — there is no multimodal
content-array shape anywhere in this project's types, and the pinned primary
model (`deepseek/deepseek-v4-flash`) cannot process images at all. The
captioning call is a standalone OpenAI-compatible HTTP request against
OpenRouter (same pattern as `OllamaLocalChatClient` in
[`src/engine/local-explore.ts`](../src/engine/local-explore.ts): a small,
separate client outside the main `LlmClient` abstraction, because those are
typed around the text-only `ChatMessage` shape).

The feature lives in [`src/vision/describe.ts`](../src/vision/describe.ts):
`describeImage(imagePath)` reads the file, base64-encodes it into a standard
`image_url` content part, posts it to OpenRouter's chat-completions endpoint
with a system prompt that demands concrete, actionable detail (visible text
verbatim, layout, UI element states, colors that carry meaning, anything
visually wrong), and returns the description text plus the provider's real
token counts.

## Where it is wired in

- **`browser_action` screenshot** ([`src/tools/browser/handler.ts`](../src/tools/browser/handler.ts)):
  after the PNG is saved, it is described immediately and the text
  description is embedded in the tool result alongside the file path — so a
  screenshot is useful to the model for the first time. A vision failure is
  non-fatal: the screenshot still returns, with a note that the description
  failed.
- **`describe_image` tool** ([`src/vision/tool.ts`](../src/vision/tool.ts)):
  general-purpose captioning for any image already in the workspace
  (repo-checked-in screenshots, diagrams, mockups). Schema is a single
  `path` relative to the workspace root, guarded by
  `resolveWithinWorkspace` ([`src/tools/executor.ts`](../src/tools/executor.ts)).
  Registered in `code` mode's tool set (see `appendDescribeImageTool` in
  [`src/engine/prompt.ts`](../src/engine/prompt.ts)), and nudged in
  [`.roo/rules-code/rules.md`](../.roo/rules-code/rules.md) so models
  actually reach for it.
- **Cost tracking**: both paths report real token counts back through
  `ToolContext.onAuxLlmUsage` → `recordAuxLlmUsage` in
  [`src/engine/loop.ts`](../src/engine/loop.ts), which records into the same
  `BudgetTracker` and running session totals as a main LLM call — captioning
  is never an untracked side channel. The screenshot auto-caption only runs
  when a real accounting session is attached (bare/read-only executors have
  no `onAuxLlmUsage`, so they never spend money behind the session's back).

## Model choice — evaluated live, not guessed

The project owner required "the absolute lowest cost model on openrouter,
but it also has to be competent" — explicitly balanced, no quality sacrifice
for cost. A real evaluation ran against the live API (see
[`plans/image-support.md`](../plans/image-support.md)): three synthetic but
real screenshots covering the actual use cases (a page with a visible
error, a data-dense dashboard, a terminal with fine error detail) × four
candidate models, with live pricing pulled from OpenRouter's `/models`
endpoint at eval time.

Results (2026-08-02):

- `qwen/qwen3.7-flash` ($0.030/$0.130 per M tokens — cheapest) — **could
  not run**: HTTP 404, its only provider (`alibaba`) is not in this
  account's allowed-providers list.
- `openai/gpt-5-nano` ($0.050/$0.400) — **could not run**: HTTP 404 from
  the account's guardrail/data-policy settings.
- `google/gemma-3-12b-it` ($0.050/$0.150) — ran. ~$0.00007–0.00011 per
  image (586 prompt tokens incl. the base64 image, 241–512 completion
  tokens). Captured the broken-page error text verbatim, correctly identified
  the overlapping error panel and the layout defect, quoted the terminal's
  `ENOSPC` error and `92% full` disk line, and preserved the dashboard's
  table values. Minor misreads on fine detail (e.g. an image placeholder as a
  "checkbox", `~/app` as `~/apps` in one run).
- `google/gemma-3-27b-it` ($0.080/$0.450 — quality anchor) — ran.
  ~$0.00015–0.00019 per image. Comparable detail, but on the consistency
  re-run it **hallucinated the same wrong dashboard trend percentage
  (`+22.4%` vs the real `+12.4%`) on both runs**, and invented a duplicate
  stack frame (`buildAssetsSync`) on the terminal image — the exact
  "lazy-but-confident" failure mode the eval was built to catch.

**Default: `google/gemma-3-12b-it`.** It is the cheapest candidate that
actually ran (both cheaper candidates were blocked at the account level, not
by quality), and on the primary use case — a broken page that must be
diagnosed from text alone — its description was not materially worse than
the 27b quality anchor: same verbatim error text, same correct layout
diagnosis, at roughly half the cost. The one fine-detail metric where 27b
looked better (consistency) turned out to be consistency *in hallucinating*.
The live smoke test confirmed the 12b description is enough for
`deepseek/deepseek-v4-flash` to correctly diagnose the page's JavaScript
error and layout bug from the text alone. Override via
`HEADLESSCODE_VISION_MODEL` (reuses `HEADLESSCODE_OPENROUTER_API_KEY`); the 27b is priced
in [`src/budget/cost.ts`](../src/budget/cost.ts) too, so an override to the
quality anchor still estimates accurately.

## Follow-up (explicitly out of scope here)

Dashboard image-upload UI (file-upload handling + session-launch changes) is
a real, separate piece of work. `describe_image` already sets it up: an
uploaded image lands in the workspace and the model can caption it with one
tool call.
