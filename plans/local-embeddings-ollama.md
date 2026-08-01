# Local Ollama embeddings for codebase_search — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. The
project owner has a local machine with Ollama installed, an RTX 5080 (16GB
VRAM), 32GB system RAM, and already has `qwen3-embedding:8b` pulled
(confirmed via `ollama list` — 4.7GB). This task is specifically about
using that, not a hypothetical future setup.

Match this project's established style: no test framework (plain `tsx`-run
test files, `All N tests passed` trailer); minimal new dependencies (plain
`fetch` against Ollama's local HTTP API, matching how `src/llm/openrouter.ts`
uses plain `fetch` with no SDK); `npx tsc --noEmit` and `npm test` must stay
green; re-run every e2e suite under `scripts/e2e*/run.sh`.

## Note on concurrent work

`plans/codebase-search-activation.md` may be running at the same time —
it touches index-building/worktree setup/prompt guidance, this task touches
`src/codesearch/embedder.ts` and adds a new file. Low file-overlap risk, but
if you hit a merge conflict under `src/codesearch/`, resolve by re-reading
the other task's actually-merged final state rather than guessing.

## The problem / motivation

`src/codesearch/embedder.ts` currently only talks to OpenRouter
(`qwen/qwen3-embedding-4b`, real $/1M pricing wired into
`src/budget/cost.ts`). Every `headlesscode index` run costs real money and a
network round-trip per batch. Embeddings are a low-risk place to use a local
model — the job is "produce a decent vector," not "make a coding judgment
call" — and the project owner already has hardware and a pulled model ready
to use. This task adds a local Ollama backend as an alternative to the
existing OpenRouter one, not a replacement — both should keep working.

## Before you design anything — verify Ollama's real embeddings API shape

Do not assume. Ollama exposes an embeddings endpoint locally (default
`http://localhost:11434`) — verify the exact request/response shape against
a real local call (the project owner's machine has Ollama running with
`qwen3-embedding:8b` already pulled; if your environment doesn't have local
Ollama access, say so plainly and describe what you verified from Ollama's
own documented API instead of guessing). Specifically confirm:
- The actual endpoint path and whether it accepts a batch of inputs in one
  call (matters for cost/speed exactly like the OpenRouter case — check
  `src/llm/openrouter.ts`'s `embed()` method's own comment about verifying
  batch support before assuming) or requires one request per string.
- Response shape (embedding array location, whether usage/token-count
  metadata is even meaningful for a fully local call — there's no real
  "cost" to track, but chunk-count/timing might still be worth recording).
- Whether the model needs to be "warm" (loaded into VRAM) and what the
  latency looks like for a cold vs warm call — relevant for whether a large
  first-time index build should batch aggressively or trickle.

## What to build

**1. A local embedder implementing the same interface as the OpenRouter
one.** Check how `src/codesearch/embedder.ts` currently exposes its
embedding function/interface to the rest of `src/codesearch/` (chunk.ts,
index.ts, the `codebase_search` handler in `src/tools/executor.ts`) and add
a second implementation behind the same shape — this should NOT require
changes to chunking/index-storage/search logic, only to how a batch of
strings becomes a batch of vectors. New file `src/codesearch/ollama-embedder.ts`
(or extend the existing file if that fits better — your call, but don't
duplicate the batching/hashing logic that already exists for the cloud
path).

**2. Selection mechanism.** New env var (e.g. `HEADLESSCODE_EMBEDDING_BACKEND`,
values `openrouter` | `ollama`, default stays `openrouter` — do not silently
change default behavior for existing setups without explicit opt-in) plus a
`--embedding-backend` flag on `headlesscode index`, following the same
pattern as `HEADLESSCODE_EMBEDDING_MODEL`/`--model` already established in
`plans/codebase-search.md`'s implementation. When `ollama` is selected, an
`HEADLESSCODE_OLLAMA_URL` (default `http://localhost:11434`) and an embedding
model name (default `qwen3-embedding:8b`, matching what's actually pulled)
should be configurable the same way.

**3. Dimension compatibility.** Check whether `qwen3-embedding:8b` (local)
and `qwen/qwen3-embedding-4b` (cloud, currently used) produce
same-dimensional vectors. They likely do NOT (different model sizes usually
mean different embedding dimensions) — if so, an index built with one
backend is NOT usable for search with the other. Handle this explicitly:
either record which backend/model built a given index (in the index file's
own metadata, or a sibling small metadata file) and refuse a search that
mismatches with a clear error ("index was built with backend X, but you're
querying with backend Y — rebuild the index or switch backends"), or
document clearly that switching backends always requires a full reindex.
Do not let a dimension mismatch silently produce garbage similarity scores.

**4. Cost accounting.** A local embedding call has no real $ cost — do not
feed fake/zero entries into `src/budget/cost.ts` in a way that would look
like a bug later; just don't call the cost-tracking path for local calls,
or record it as `$0` explicitly and clearly, your call, but be deliberate
about it either way.

**5. Failure handling.** Ollama not running locally, or the model not
pulled, must produce a clear, actionable error ("Ollama backend selected but
http://localhost:11434 is unreachable — is `ollama serve` running? Or is
`qwen3-embedding:8b` not pulled — run `ollama pull qwen3-embedding:8b`"), not
a generic network error or a silent fallback to the cloud backend (a silent
fallback would surprise the user with unexpected spend).

## What NOT to do

- Do not make `ollama` the new default backend — opt-in only, since not
  every environment (e.g. a hosted worker with no local GPU) has Ollama
  available. `plans/codebase-search.md`'s original spec explicitly built the
  cloud path FOR headless/hosted use where local Ollama isn't an option —
  don't regress that.
- Do not touch chunking or index storage format beyond what's needed for
  the backend-metadata/dimension-mismatch handling in item 3.
- Do not add a general-purpose Ollama HTTP client abstraction beyond what
  this embedding use case needs — keep it scoped.

## Tests

- New `src/codesearch/__tests__/ollama-embedder.test.ts`: request/response
  shape handling against a fake local HTTP server (mirror how
  `src/llm/__tests__/openrouter.test.ts` or the e2e mock-OpenRouter server
  pattern works — do not require a real Ollama instance for the unit
  suite), including the batch-vs-one-call-per-input behavior you verified.
- A test proving the backend-selection env var/flag actually switches which
  embedder gets used.
- A test proving the dimension-mismatch handling from item 3 actually
  refuses (or clearly documents) a cross-backend search attempt.
- A test proving Ollama-unreachable produces the clear actionable error
  described above, not a generic failure.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. If you have real local Ollama access: run `headlesscode index
   --embedding-backend ollama --workspace <scratch repo>` for real, confirm
   the index file has sane content, then run a real `codebase_search` query
   against it and confirm relevant results. If you do NOT have local Ollama
   access in your environment, say so plainly and describe what you
   verified instead (request/response shape against Ollama's documented
   API, unit tests against a faked server).

## What to report back

- What you found verifying Ollama's real embeddings API shape (batch
  support, response format, latency characteristics).
- Whether local and cloud embeddings are dimensionally compatible, and how
  you handled it if not.
- Confirmation of tsc/test/e2e results.
- Whether the real local smoke test ran, and why/why not.
- Any deviation from this spec, and why.
