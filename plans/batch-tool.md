# `batch` tool — spec

## Goal

Give models that emit one tool call per turn (mostly smaller/local ones)
the same per-turn throughput strong models get from native batching —
without changing the loop's ordering or safety contracts.

## Shape

One new tool, `batch`. Args:

- `calls: [{ tool: string, args: object }]` (required, 1–10 sub-calls)
- `stop_on_error?: boolean` (default false)

Each sub-call's `args` is validated the way the loop validates top-level
calls. An unparseable sub-call becomes a per-section error, not a
batch failure. Over-cap or empty `calls` is a batch-level error.

## Execution semantics

The handler mirrors the loop's S3 partition internally: sub-calls are
classified by the same read-only/edit rules; reads run concurrently and
edits run strictly in submission order. A read of a file another
sub-call in the same batch edits goes serial, in position (same rule as
`isParallelReadOnlyCall`).

`execute_command` sub-calls are allowed: read-only-equivalent commands
(S3's existing test) join the concurrent group, all others go
serial-in-position. A sub-call that times out into the background yields
the standard "still running" message as its section.

No nesting: a sub-call naming `batch` is refused as a per-section error.

## Refusals (per-section errors, siblings still run)

- `new_task`, `switch_mode`, `ask_followup_question`: the single
  decision-marker protocol must stay single-writer.
- `attempt_completion`: completion must observe real results (same
  rationale as the bundled-completion refusal).
- Unknown tool names.

## Failure visibility (owner decision)

Failures must not be hidden. Every batch result carries:

- Per-section ok/error markers in submission order.
- A summary line with partial counts: `N sub-calls: X ok, Y errors.`
- `isError: true` when the batch is malformed OR when zero sub-calls
  succeeded. Partial success returns `isError: false` — the errors are
  visible in the sections and counts, but productive explore-and-retry
  flows are not punished by mistake accounting.

## Read-only executors

`batch` is registered on the reviewer/QA executor too, with no special
variant: every sub-call is gated on `executor.has()`, so edit sub-calls
there become per-section "not available on this executor" refusals
(write tools are simply not registered on read-only executors).
Reads-only batches work identically everywhere.

## Schema strictness

`strict: false` (the only non-strict tool schema): sub-call `args` are
free-form per-tool objects, which strict schemas cannot express. Each
sub-call is validated at runtime instead. Tools pass straight through
to the provider (`body.tools = request.tools`), so a strict flag here
would be enforced — hence the deliberate opt-out, documented in
src/tools/batch.ts.

## Result format

Single `ToolResult`. Body is labeled sections in submission order:

```
[1/3] read_file {"path": "src/x.ts"} — ok
<content, truncated per-section at 20k chars>
[2/3] go_to_definition {...} — error
[Error] ...
3 sub-calls: 2 ok, 1 error.
```

Total body capped (~60k chars) with a truncation note naming which
sections were cut. `stop_on_error: true` skips remaining sub-calls
after the first error and notes it.

## Loop interplay

No loop changes. `batch` arrives as one call, lands in the serial group
(not in `PARALLEL_READ_ONLY_TOOL_NAMES`), counts as one call for
mistake accounting.

## Prompt

Add a short batching nudge to the tool-use guidelines: independent
reads go in one `batch` (or one native block for models that batch
natively); never put a read of a file being edited in the same batch
ahead of seeing the edit result.

## Wiring

- New files `src/tools/batch.ts` (handler + execution) +
  `src/tools/batch-format.ts` (rendering) + `src/tools/batch-tool.ts`
  (schema) + `src/tools/__tests__/batch.test.ts`.
- Schema advertised via `appendBatchTool` (loop ×2, QA, CLI dry-run),
  gated on `executor.has("batch")` like the other non-vendored tools.
- `executor.register("batch", ...)` in both the headless and
  read-command executors. The batch handler reaches the executor via
  closure capture (the `run_tests` precedent) — `execute()` is
  stateless per call and safe to fan out through.
- Reuses the S3 partition (`isParallelReadOnlyCall`,
  `editToolTargetPath` from `src/engine/tool-classes.ts`, moved out of
  loop.ts so tools/* can import it without an engine import cycle)
  rather than reimplementing read/edit classification.
- The five new codeintel tools are auto-eligible as batch sub-calls
  once registered — no extra work.

## Tests (through the real executor, tmpdir fixtures)

- All-reads batch returns all sections.
- Mixed read/edit preserves order semantics (edit-then-read sees
  post-edit content).
- Refused tools (`attempt_completion`, `new_task`, nested `batch`)
  become per-section errors with siblings executed.
- Read-only executor refuses an edit sub-call.
- 11 sub-calls → batch-level error; `stop_on_error` skips.
- Truncation note present on oversized output.
- Partial failure: counts line present, `isError: false`; all-fail:
  `isError: true`.

## Measure

Compare turns-to-complete and wall time on a fixed eval set (weak model
vs strong model) before/after. Expect turns down sharply on the weak
model, roughly flat on the strong one.
