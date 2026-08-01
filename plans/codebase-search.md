# Implement codebase_search with a cloud (OpenRouter) embedding model — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI that runs a headless coding-agent loop (ported
from a VS Code extension called Zoo Code, vendored under `src/vendor/zoo-code/`).
The full original source is also available for reference (read-only, do not
edit) at `zoo-code/` in this repo.

Match this project's established style: no test framework (plain `tsx`-run
test files, `All N tests passed` trailer); minimal new dependencies (this
project deliberately avoids frameworks/heavy libraries — see
`src/memory/embed.ts`'s own header comment describing its "ZERO-DEPENDENCY"
philosophy, though this task is explicitly the case where a real network
call is justified, see below); `npx tsc --noEmit` and `npm test` must stay
green; re-run every e2e suite under `scripts/e2e*/run.sh` afterward.

## The problem

`codebase_search` (semantic search over a repo's source, as opposed to
literal grep) is one of the vendored native tools
(`src/vendor/zoo-code/src/core/prompts/tools/native-tools/codebase_search.ts`
— read it for the exact tool contract/description the model is shown) but is
still a stub in `src/tools/executor.ts` (`stubHandler`) — calling it just
returns "not implemented." This matters more for headless/hosted operation
than it might have for local VS Code use: the project owner currently
configures Ollama running locally with a Qwen embedding model for this
feature in the interactive extension, which isn't available on a headless
server with no local GPU/Ollama process. This task builds a real
implementation backed by a cloud (OpenRouter) embedding model instead.

**This is a separate subsystem from the existing Phase 3 memory embedder**
(`src/memory/embed.ts`, `createLocalEmbedder`) — that one is a deliberately
cheap, zero-dependency, deterministic hash-based stand-in used ONLY for
small-scale session-summary/fact recall (a handful of short text records per
project). Do not touch it, do not reuse its output for codebase search, and
do not feel obligated to replace it with a cloud call too — it's explicitly
designed to be swappable later behind its own `Embedder` interface
(`src/memory/types.ts`) if that's ever wanted, but that's not this task. This
task is a NEW, separate index over an entire repo's source files, which is a
fundamentally bigger, different-shaped problem (many files, needs chunking,
needs a persisted index, needs real embedding quality to be useful for code).

## Before you design anything — verify OpenRouter's actual embeddings support

Do not assume OpenRouter's embeddings API shape or model availability —
verify against OpenRouter's real, current documentation before writing the
client code (this project already has one OpenRouter client,
`src/llm/openrouter.ts`, for chat completions — check whether embeddings go
through the same base URL with a different path, e.g. `/api/v1/embeddings`,
or need different handling entirely). Specifically confirm:
- Which embedding models are actually available via OpenRouter today, and
  their pricing (this feeds `src/budget/cost.ts` — codebase indexing a large
  repo could embed a LOT of tokens, this needs to be budget-aware, not an
  unbounded surprise cost).
- Request/response shape (batch support — embedding many chunks in one call
  is much cheaper/faster than one call per chunk, if the API supports it).
- Any dimension/model-specific constraints relevant to storing vectors later.

If OpenRouter's embeddings support turns out to be too limited/unclear to
build on confidently, say so plainly in your report with what you found,
rather than shipping something built on assumptions — this is exactly the
kind of thing to flag rather than guess through.

## What to build

### 1. A cloud embedder (separate from the Phase 3 one)

New `src/codesearch/embedder.ts`: a function/class that embeds a batch of
text chunks via OpenRouter's embeddings endpoint, using a new, small,
focused client (extend `src/llm/openrouter.ts` if the endpoint is a natural
sibling method on the existing client, or add a new file if it's different
enough — your call, but don't duplicate the existing auth/base-URL/error-
handling logic, factor out what's shared). Must:
- Batch requests where the API supports it (don't make one HTTP call per
  chunk for a large repo).
- Feed real token usage into `src/budget/cost.ts` the same way chat
  completions already do (extend the pricing table with the embedding
  model's real rate — do not guess a price, use what you verified above).
- Be swappable/configurable via env (`HEADLESSCODE_EMBEDDING_MODEL` or
  similar, with a sane default once you've picked a real model).

### 2. Chunking

New `src/codesearch/chunk.ts`: split a source file into chunks suitable for
embedding + later citation (a chunk needs to map back to a `file:startLine-
endLine` reference, since that's what a search result needs to be useful to
the model). A reasonable approach: chunk by top-level function/class
boundaries where a simple heuristic can find them (don't build a full
per-language parser — check if a good-enough regex/indentation heuristic
covers this project's own language mix reasonably, and document its
limitations rather than over-engineering language-aware parsing), falling
back to fixed-size line windows with a small overlap for files where
boundary detection doesn't apply well. Skip binary files, generated files,
and anything already excluded by `.gitignore` (there should be a git-aware
file-listing helper already used elsewhere in this project — check
`list_files`'s implementation in `src/tools/executor.ts` and the vendored
checkpoint `excludes.ts` for existing exclude-pattern conventions to reuse
rather than reinventing).

### 3. Index storage + build command

New `src/codesearch/index.ts` (storage) — a persisted index at
`<workspaceRoot>/.headlesscode/codesearch/index.jsonl`, one JSON line per
chunk: `{ file, startLine, endLine, embedding: number[], hash }` (`hash` = a
content hash of the chunk, so re-indexing can skip unchanged chunks rather
than re-embedding the whole repo every time — this matters a lot for cost,
don't skip it). Brute-force cosine similarity at query time is fine for this
project's own scale (no vector DB dependency) — but note the scaling limit
explicitly in a comment (this approach degrades on very large repos; that's
an acceptable, documented tradeoff for now, not something to solve in this
task).

New CLI subcommand `headlesscode index --workspace <path>` (mirror the
existing subcommand dispatch pattern in `src/cli.ts` — `orchestrate`/`watch`/
`checkpoints`/`dashboard` are all examples): walks the workspace's real
source files (respecting `.gitignore`, per above), chunks, embeds only
chunks whose content hash changed since the last index (incremental), writes
the index file. Print a summary (files scanned, chunks embedded vs. skipped
as unchanged, estimated cost).

### 4. The actual `codebase_search` tool handler

In `src/tools/executor.ts`: replace the stub with a real handler. Given a
query string, embed it (one call), load the persisted index, compute cosine
similarity against every stored chunk, return the top-K matches formatted as
`file:startLine-endLine` + a snippet (check the vendored tool's own
description for what result shape/format the model expects — match it).
- If no index exists yet for the workspace, return a clear, actionable error
  telling the model (or whoever's running this) to run `headlesscode index`
  first — do not silently return empty results, that would look like "no
  matches" instead of "not indexed."
- This tool should move from the stub set into `IMPLEMENTED_TOOLS` in
  `createHeadlessExecutor`, same as the diff-editing tools did in an earlier
  round of work — check that file's current structure before assuming where
  to add it.

## What NOT to do

- Do not touch `src/memory/embed.ts`/the Phase 3 memory system — separate
  concern, explicitly out of scope, explained above.
- Do not build a real vector database integration (pgvector, Qdrant, etc.) —
  brute-force cosine over a flat JSONL file is the deliberate scope for now.
- Do not make indexing automatic/implicit (e.g. auto-triggered at the start
  of every session) — it's a separate, explicit `headlesscode index` step,
  since it costs real money and takes real time; a session should use
  whatever index already exists, or tell the model to ask a human to build
  one, not silently trigger a possibly-expensive build mid-session.
- Do not implement true multi-language AST-aware chunking — the
  heuristic/fallback approach above is the deliberate scope.

## Tests

- New `src/codesearch/__tests__/chunk.test.ts`: chunking produces sane
  file:line-mapped chunks for a few representative fixture files (a
  TypeScript file with clear function boundaries, a file with none),
  confirms `.gitignore`d/binary files are skipped.
- New `src/codesearch/__tests__/index.test.ts`: building an index twice with
  no changes re-embeds nothing (hash-based skip actually works — prove it
  with a call counter on a fake embedder, not just by reading code); a
  changed chunk gets re-embedded; an unchanged one doesn't.
- New `src/codesearch/__tests__/search.test.ts` (or extend the executor
  tests): a query against a small fixture index returns the expected
  top-K ordering (use a deterministic fake embedder for the test — a real
  network-calling embedder has no place in a fast, offline test suite,
  mirror how other tests in this project always inject a fake LLM
  client rather than hitting the real API).
- Extend `src/tools/__tests__/` for the `codebase_search` handler itself:
  no-index-yet returns a clear actionable error, not empty results.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. A real manual smoke test, IF you have real OpenRouter API access in your
   environment: run `headlesscode index` against a small scratch repo,
   confirm the index file has sane content, then run a real session
   (mock-LLM scripted to call `codebase_search`) and confirm it gets real,
   relevant results back. If you do NOT have real API access, say so
   plainly and describe what you verified instead (e.g. the request/response
   shape against OpenRouter's documented API, even without making a live
   call) — do not claim this was tested end-to-end if it wasn't.

## What to report back

- Files changed/added.
- What you found verifying OpenRouter's embeddings support (model chosen,
  pricing, batch behavior) — this is load-bearing information the project
  owner needs, not just an implementation detail.
- Confirmation of tsc/test/e2e results (actual pass/fail counts).
- Whether the manual smoke test was run against a real API or not, and why.
- Any deviation from this spec, and why.
- Anything you noticed while doing this that looks like a related bug or
  gap, even if unfixed — flag it rather than ignoring it.
