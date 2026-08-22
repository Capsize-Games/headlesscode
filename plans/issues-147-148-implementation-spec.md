# Implementation spec: headlesscode issues #147 and #148

Prepared 2026-08-22 for hand-off to an interactive coding agent. Written from
real, verified repo state — not from the issue bodies alone. Every file:line
citation below was confirmed by reading the actual code on this date; **code
moves, so re-verify citations before trusting them** if much time has passed.

Both issues are open on GitHub (`Capsize-Games/headlesscode`). Despite an
earlier belief that they were finished, neither is: #147 has zero related
commits in headlesscode history and no supporting endpoint in airunner;
#148 has exactly one commit (`a27e57f`), which only adds a mode *definition*
with no pipeline code wired up. Both are real, substantial pieces of work.

This is one overview document covering both issues, meant for a
human-in-the-loop VS Code coding agent (not an unattended autonomous
dispatch) — the human driving it should feel free to tackle #147 and #148
as separate sessions/branches, and to split either section further if it
turns out to be too much for one sitting.

---

## Issue #147 — native AIRunner embedder backend for `codebase_search`

**Repos touched:** `airunner` (Python/FastAPI server) and `headlesscode`
(Node/TS). Two independent halves; airunner's endpoint should be built and
verified first since headlesscode's new backend calls it.

### Background

`codebase_search`'s embedder today supports two backends
(`headlesscode/src/codesearch/embedder.ts`): cloud OpenRouter and a local
Ollama-API-compatible daemon. Explicit product decision: build a *third*
backend on AIRunner's own native local embedding stack instead of routing
through the Ollama-shaped shim — that stack already exists and runs
in-process, it's just never been exposed to an external caller.

### Part A — airunner: expose a text-embedding HTTP endpoint

**The embedding model that already exists:**
`server/src/airunner_services/llm/managers/agent/mixins/rag_properties_mixin.py:58-129`
— `RAGPropertiesMixin.embedding` is a lazy `@property` that loads a local
`langchain_huggingface.HuggingFaceEmbeddings` instance
(`intfloat/e5-large`, device auto-selected cuda/mps/cpu,
`normalize_embeddings: True`), caches it on `self._embedding`, and emits
`MODEL_STATUS_CHANGED_SIGNAL`. Loading is triggered today via
`server/src/airunner_services/llm/workers/mixins/rag_indexing_mixin/_embedding.py`'s
`_ensure_embedding_loaded()` / `on_rag_load_embedding_signal` (wired to the
Model Resources panel's load button).

**The helper functions to reuse:**
`server/src/airunner_services/llm/managers/agent/pgvector_store.py:27-54` —
three free functions, all taking the `HuggingFaceEmbeddings` instance as
their first arg:
- `embed_passages(embedding_model, texts, priority="live") -> list[list[float]]`
  — prefixes each text `"passage: "`, calls `embedding_model.embed_documents`.
- `embed_query(embedding_model, text, priority="live") -> list[float]` —
  prefixes `"query: "`, calls `embedding_model.embed_query`.
- `embed_texts(embedding_model, texts, priority="live") -> list[list[float]]`
  — no prefix, calls `embedding_model.embed_documents`.

Note: `HuggingFaceEmbeddings.embed_documents`/`embed_query` don't natively
accept a `priority` kwarg — there's a wrapper/subclass handling that
somewhere; check at implementation time rather than assuming.

**Critical routing decision — do NOT use `_rpc_register`.** That decorator
(`server/src/airunner_services/api/routes/events_rpc.py:124-136`) only
registers handlers reachable through the single `/events` WebSocket endpoint
(`routes/events.py:268`, `_dispatch_rpc`) — there is no HTTP mount for it.
`routes/__init__.py` even documents this as a "WebSocket-only architecture."
Since headlesscode is an external Node process making a plain HTTP call,
this endpoint must instead be a genuine FastAPI `APIRouter` with
`@router.post(...)`, the same shape as `health.py`, `images.py`, or
`llm_http_routes.py`.

**Auth:** this is local tooling, not user data — no tenant/session scoping
needed. Follow `health.py:57-87`'s established pattern for intentionally
unauthenticated routes: a `# nosemgrep: missing-auth-dependency (public
health/readiness endpoints)` comment explaining the opt-out, rather than
silently having no auth.

**Registration:** new module under `server/src/airunner_services/api/routes/`
(suggest a name distinct from the existing `rpc_embeddings.py`, which is
unrelated — it's `/api/v1/art/embeddings`, textual-inversion/art embeddings
against a DB model, not text embedding vectors; don't confuse the two or try
to reuse it). Add an entry to `_ROUTE_SPECS`/`_ROUTE_SPECS_2` in
`server_routes_specs.py` (tuple format:
`(name, "airunner_services.api.routes.<module>", {"prefix": "/api/v1", "tags": [...]}, [])`)
— `register_routes()` (`server_routes.py:49-57`) auto-imports and mounts it.
No change needed to `routes/__init__.py` (that file only handles WS-RPC
side-effect imports).

**Open design questions the implementer needs to resolve (not yet decided):**
1. How does a standalone HTTP route obtain a *loaded* embedding-model
   instance outside a full LLM-agent context? `RAGPropertiesMixin.embedding`
   is normally accessed through an agent instance. Options: find/reuse
   whatever object in this process already owns the loaded model (the RAG
   indexing worker), or lazily construct+cache one directly in the new
   route module the same way the property does.
2. Symmetric (`embed_texts`, no prefix) vs. asymmetric (`embed_passages`/
   `embed_query`, e5-style prefixing) embeddings — e5 was trained with this
   asymmetric convention and it measurably helps retrieval quality, but
   `codebase_search` currently treats chunk-embedding and query-embedding as
   symmetric calls through one `Embedder.embedBatch` interface on the
   headlesscode side (see Part B). Decide explicitly whether the new
   endpoint takes a `mode: "passage" | "query"` param, or whether it's
   simpler to always use `embed_texts` and accept the small quality hit for
   API-shape simplicity matching the existing `ollama`/`openrouter` backends.

**Suggested endpoint shape:** `POST /api/v1/embed/text` — request
`{"texts": string[]}`, response `{"model": "intfloat/e5-large", "embeddings": number[][]}`.

### Part B — headlesscode: add the `airunner` embedder backend

**`src/codesearch/embedder.ts`** — the backend registry:
```ts
export const EMBEDDING_BACKENDS = ["openrouter", "ollama"] as const
export const DEFAULT_EMBEDDING_BACKEND = "openrouter"
export const EMBEDDING_BACKEND_ENV = "HEADLESSCODE_EMBEDDING_BACKEND"

export function resolveEmbeddingBackend(env = process.env, override?: string): EmbeddingBackend {
	const raw = (override?.trim() || env[EMBEDDING_BACKEND_ENV]?.trim() || DEFAULT_EMBEDDING_BACKEND).toLowerCase()
	if (raw === "ollama" || raw === "openrouter") { return raw }
	throw new Error(`Invalid embedding backend "${raw}" ...`)
}
```
Add `"airunner"` to `EMBEDDING_BACKENDS` and to the whitelist check +
error message in `resolveEmbeddingBackend` (lines ~90-130).

`createEmbedder` (lines ~209-230) dispatches by resolved backend:
```ts
export function createEmbedder(
	backend?: EmbeddingBackend,
	options: { model?: string; ollamaModel?: string; ollamaUrl?: string } = {},
	env: NodeJS.ProcessEnv = process.env,
): Embedder {
	const resolved = resolveEmbeddingBackend(env, backend)
	if (resolved === "ollama") {
		return new OllamaEmbedder(options.ollamaModel ?? resolveOllamaEmbeddingModel(env), options.ollamaUrl ?? resolveOllamaUrl(env))
	}
	return new OpenRouterEmbedder(...)
}
```
Add an `airunner` branch constructing a new `AirunnerEmbedder`, with
`airunnerModel`/`airunnerUrl` options mirroring the ollama ones.

**New file `src/codesearch/airunner-embedder.ts`**, modeled directly on
`src/codesearch/ollama-embedder.ts` (206 lines — read it as the literal
template). That file's `OllamaEmbedder` class has this shape, which the new
one should mirror:
- `readonly backend = "ollama" as const`, `readonly model`, private `baseUrl`
  (trailing slash stripped in constructor).
- `embedBatch(texts: string[])`: empty-array short-circuit → empty-string
  guard → one `fetch(POST ${baseUrl}/api/embed, {model, input: texts})` per
  whole batch (batching itself happens in the caller, `index.ts`, not
  internally) → network-error branch (custom `OllamaEmbedError`, actionable
  message) → non-OK-status branch → JSON-parse guard → array-length guard →
  per-vector numeric validation → returns
  `{embeddings, model, promptTokens, totalTokens}` (token counts are
  approximate — sum of vector lengths, no real tokenizer call).
- Custom `OllamaEmbedError extends Error` with optional `status`/`body`,
  and an `excerpt()` helper truncating error bodies to 500 chars.

**Config env vars** (keep the established `HEADLESSCODE_` prefix
convention, matching `HEADLESSCODE_OLLAMA_URL` /
`HEADLESSCODE_OLLAMA_EMBEDDING_MODEL`):
`HEADLESSCODE_AIRUNNER_EMBED_URL` (e.g. default `http://localhost:8000`) and
`HEADLESSCODE_AIRUNNER_EMBED_MODEL`.

**Other edits:**
- `src/codesearch/types.ts:37` — `IndexEntry.backend?: "openrouter" | "ollama"`
  needs `"airunner"` added to the union.
- **Critical fix, `src/codesearch/index.ts:219`** —
  `loadIndexMetadata` currently hardcodes a *binary* mapping:
  `const backend = parsed[METADATA_BACKEND_KEY] === "ollama" ? "ollama" : "openrouter"`.
  Without fixing this to a proper 3-way (or generic, driven off
  `EMBEDDING_BACKENDS`) mapping, any index built with the new `airunner`
  backend will be silently misread as `"openrouter"` on load — a real
  correctness bug, not just a missing feature. `IndexMetadata`'s type
  already uses the shared `EmbeddingBackend` type, so it updates
  automatically once the `EMBEDDING_BACKENDS` const gains `"airunner"`; only
  this one hardcoded ternary needs a manual fix.
- `src/codesearch/index.ts:384` (chunk-reuse check,
  `(old.backend ?? "openrouter") === backend`) and `checkEmbeddingDimensions`
  (231-255) need no logic change — already generic.
- `src/codesearch/cli.ts` — `--embedding-backend` flag parsing (~97-113) is
  already generic (just stores the string, validated later by
  `resolveEmbeddingBackend`), no change needed there. Add an
  `if (backend === "airunner")` stdout note block alongside the existing
  `if (backend === "ollama")` one (~154-157), and update usage-text/env-var
  docs (lines ~44, 50-61).
- Top-level `src/cli.ts:202-207` help text — mention `airunner` alongside
  `openrouter`/`ollama`.
- `src/tools/executor.ts:2203-2227` (the `codebase_search` handler's
  dimension-mismatch guard) — **needs no change**, already generic over the
  `EmbeddingBackend` type: compares `metadata.backend !== queryBackend` and
  errors if they differ.
- Existing test file to extend: `src/codesearch/__tests__/backend-selection.test.ts`.

### What NOT to do (from the issue)

Don't touch or remove `ollama-embedder.ts`/Ollama support — this is
additive. Don't route the new backend through the existing Ollama-compatible
daemon shim even indirectly.

### Verification

1. `curl` the new airunner endpoint directly with sample text; confirm a
   1024-dim vector (e5-large's dimension) comes back.
2. `headlesscode index --embedding-backend airunner` against a small test
   repo; confirm the written index metadata has `backend: "airunner"` (not
   silently `"openrouter"` — this is exactly what the index.ts:219 fix
   above prevents).
3. Run a real `codebase_search` query against that index; confirm sane
   results.
4. Confirm the existing safety check still works: querying an
   airunner-built index with `HEADLESSCODE_EMBEDDING_BACKEND=openrouter`
   set should still produce the existing mismatch error, not silently
   query with the wrong backend.

---

## Issue #148 — separate agent/harness pairs per pipeline stage

**Repo touched:** `headlesscode` only.

### Background

Today, `multi-agent-orchestrator-headless` mode gives ONE continuous
session the entire explore→architect→file→implement→review pipeline in a
single context — this causes task drift (a session meant to be researching
starts editing code instead). The **one stage already done correctly** is
review: `runReview` spawns a genuinely separate, fresh-context session
against the finished diff, rather than having the same session that wrote
the code also grade itself. The fix generalizes that pattern to every
stage: each stage = a fresh isolated session (agent role + harness
appropriate to that stage) → produces one well-defined artifact → the next
stage's fresh session takes **that artifact** as input, never the prior
stage's raw conversation.

### Current state, verified against real code (not assumed from the issue body)

**The reference-correct pattern — `src/orchestrator/reviewer.ts`:**
`runReview(options: ReviewOptions)` (line 168):
- Constructs a fresh `new HeadlessSession({...})` (`src/engine/loop.ts`) —
  an in-process class instance, not a subprocess — with its own
  `workspaceRoot`, `mode` (default `"deepseek-reviewer"`),
  `systemPromptOverride` (loaded from
  `plans/zoo-code-review-mode-prompt.md`, line 180), and a restricted
  read-only tool set: `reviewTools()` (120-124) = `read_file`,
  `list_files`, `execute_command`, `attempt_completion`,
  `ask_followup_question` — no write tools at all, enforced via
  `createReadOnlyHeadlessExecutor(workspaceRoot)` (226), which mechanically
  never registers `write_to_file` at the executor level (not just a prompt
  instruction).
- Task input: `defaultTaskText(workspaceRoot)` (137) — plain text built
  from `git branch --show-current` in the target worktree, instructing the
  session to read closing reports, re-diff, re-run checkable claims, and
  end with a required exact structured line (`VERDICT: CLEAN` /
  `VERDICT: FINDING`). **The prior session's raw conversation is never
  passed** — only the finished diff/branch state on disk plus this
  generated instruction text.
- Output: `session.run()` → `SessionResult`; `parseReviewResult(result.result)`
  (338) deterministically parses the `attempt_completion` text into
  `{findings, verdict, summary, reportPath?}`. A crashed/budget-exhausted
  session maps to `verdict: "error"` (236-243), kept distinct from a real
  `"finding"` so callers don't rework good code over an infra hiccup.
- Feed-back: `runReviewWithRetries` (266) retries only on `"error"`. Called
  from `src/orchestrator/cli.ts:2939` (main round) and
  `src/orchestrator/resume.ts:831` (`runReviewStep`), which write
  `review_verdict`/`pending_review_findings`/`reportPath` into
  `.orchestrator-state.json` and route via `handleReviewVerdict`/
  `handleReviewSessionError` (`orchestrator/cli.ts:1260,1439`).

**Main orchestrator entry point and pipeline today**
(`src/cli.ts:675` → `orchestrateMain`, `src/orchestrator/cli.ts:2337`):
1. **Split** — `splitIssues` (`orchestrator/split.ts`), deterministic, no
   LLM session.
2. **File task docs** — `writeTaskFiles`/`buildTaskFileContent`
   (`cli.ts:619-895`), plain string templating, not an agent session.
3. **Spawn** — `scripts/spawn-parallel-worktrees.sh` → `scripts/run-worker.sh`,
   one detached subprocess per worktree, each running
   `npx tsx src/cli.ts --task-file ... --mode code`
   (`run-worker.sh:86`). **This single worker session does
   explore→edit→test→self-verify all in one continuous
   `HeadlessSession`** — the exact problem the issue describes, just one
   level down (inside each worker, not just at the top coordinator level).
4. **Watch** — `watchGroups` (`orchestrator/watch.ts`) polls
   `.harness.done`/`.harness.exit` markers.
5. **Review** — `runReview`/`runReviewWithRetries` — already correct, as above.

**Already-isolated exception (prior art):** `--plan-first`
(`docs/phase2-orchestration.md:204-223`, opt-in, never default) runs a
short separate `architect`-mode `HeadlessSession` per worktree *before* the
code worker, writing `PLAN.md`, which the spawner appends into
`ORCHESTRATOR_TASK.md` for the code worker to consume. This is real,
working prior art for "fresh session produces one artifact, next session
consumes the artifact not the conversation" — but it's optional and only
covers the planning stage.

**Two modes already defined but completely unwired:**
- `researcher` (`.roomodes`, added by `a27e57f` — the only #148 commit so
  far): tool groups `read`, `command`, and `edit` restricted to
  `fileRegex: "\\.md$"`. Role: produce ONE research document at the exact
  path the task specifies; explicitly forbidden from proposing or
  attempting implementation. **Confirmed unwired**: `grep -rln researcher
  src --include="*.ts"` returns nothing — no `runResearch()` function, not
  called from any orchestrator TS code, invocable only via a manual
  `--task-file ... --mode researcher` CLI call.
- `issue-filer` (`.roomodes`): tool groups `read`, `command` only — no
  `edit` at all, files via `gh issue create` only. Role explicitly: "does
  not investigate from scratch... does not implement anything." Same
  status as `researcher` — zero orchestrator-side plumbing to spawn it.
- `deepseek-reviewer` is the *only* mode with real TS wiring
  (`reviewer.ts`).
- Modes live entirely in `.roomodes` (YAML) at the target workspace root —
  there's no `modes.ts` registry file.

**Real, structural artifact-gate primitive already built (`src/engine/loop.ts`):**
- `requireArtifactBeforeCompletion?: boolean` (1100) — weak form, did any
  write/execute tool fire before completion.
- `requireArtifactPathPattern?: string` (1116) — a glob that must match a
  real, non-empty file **on disk** (checked directly, not tool-call
  bookkeeping).
- `requireArtifactMinCitations?: number` (1128) — minimum `file:line`-shaped
  citation count in the matched file.
- `requireArtifactSections?: string[]` (1143) — required heading substrings.

Enforcement at `loop.ts:3630-3771` inside the `attempt_completion` handler:
on failure, rejects completion and injects a nudge naming exactly what's
missing. This is a real content-validated gate, exposed as CLI flags
(`src/cli.ts:485-526`) — but it's a generic engine primitive not yet bound
to any specific mode by default; `researcher` mode itself sets none of
these, they'd have to be passed explicitly per invocation today.

**No structured "artifact" object type exists between sessions** — the
artifact IS just the resulting file on disk at a known path; a caller reads
it and hands it forward manually (exactly as `--plan-first`'s spawner
already does for `PLAN.md`).

### Design: generalize the reviewer.ts pattern to all 4 stages

1. **Research/architect stage** — spawn a fresh `HeadlessSession` in
   `researcher` mode, read-only-ish tools as already configured, with
   `requireArtifactPathPattern`/`MinCitations`/`Sections` bound **by
   default for this stage** (not left opt-in-per-invocation as today).
   Output: one `.md` doc at a known path.
2. **Filing stage** — new `src/orchestrator/filer.ts`, structurally
   mirroring `reviewer.ts`: spawn a fresh `HeadlessSession` in
   `issue-filer` mode, task input built from the **research doc's file
   content read off disk** (not the research session's conversation),
   output parsed from its `attempt_completion` into real filed issue
   number(s) (mirrors `parseReviewResult`'s deterministic-parse approach).
3. **Implementation stage** — the existing per-worktree subprocess model
   (`run-worker.sh`) already gives process isolation between issues, but
   **inside** each worker, the single continuous `code`-mode session still
   combines explore+implement in one context. Splitting that into its own
   fresh-session explore-substage → implement-substage (artifact handoff,
   not conversation handoff, same pattern nested one level down) is the
   single biggest structural piece of this issue — flag it explicitly to
   whoever picks this up as the part most likely to need its own separate
   sitting.
4. **Review stage** — unchanged, reuse `reviewer.ts` as-is.

**New orchestrator-level plumbing needed:** a sequencing layer (suggest
`src/orchestrator/pipeline.ts`) that, for each stage: spawns the stage's
`HeadlessSession`, waits for completion, validates the artifact (reusing
the `requireArtifact*` gate), writes stage state into
`.orchestrator-state.json` (extending the existing schema pattern —
`review_verdict`/`pending_review_findings` already show the shape), and
constructs the next stage's fresh task text from the artifact content. This
generalizes exactly what `runReview`+`parseReviewResult` do for review and
what `--plan-first`'s spawner-side append does for planning, into one
reusable mechanism instead of two one-off ones.

### What NOT to do (from the issue)

Don't try to solve this via prompt engineering on the existing single
continuous session — task-file hardening was already tried across 7 rounds
with diminishing returns (see project history). The fix here is
structural: stop giving one session the whole pipeline's context and
responsibility at all.

### Verification

1. Live dogfood run against a real GitHub issue: confirm the research stage
   produces a real `.md` doc on disk with real content (not a fabricated
   citation — this repo has a known failure mode where a research-stage
   session invents plausible-looking but non-existent file citations under
   pressure from the artifact gate; the `verify-citations.mjs` mechanical
   checker in `scripts/eval-suite/` is the existing tool for catching that,
   worth running against this stage's output too).
2. Confirm the filing stage produces a real `gh issue create` call and that
   the issue actually exists on GitHub — don't trust the session's own
   completion narration (established practice in this repo: verify against
   real repo/GitHub state, not the transcript).
3. Confirm the implementation stage's worker session's initial task-file
   content contains *only* the filed issue's text, not the research
   session's raw conversation history.
4. Confirm the review stage still fires unchanged at the end.
5. Confirm `requireArtifactPathPattern` binds automatically for the
   research stage without needing the CLI flag passed manually each time.

---

## Sources (file:line citations gathered for this document)

**airunner (issue #147, Part A):**
- `server/src/airunner_services/llm/managers/agent/mixins/rag_properties_mixin.py:58-129`
- `server/src/airunner_services/llm/workers/mixins/rag_indexing_mixin/_embedding.py`
- `server/src/airunner_services/llm/managers/agent/pgvector_store.py:27-54`
- `server/src/airunner_services/api/routes/events_rpc.py:124-136`
- `server/src/airunner_services/api/routes/events.py:268`
- `server/src/airunner_services/api/routes/health.py:57-87`
- `server/src/airunner_services/api/routes/rpc_embeddings.py` (confirmed unrelated — art/textual-inversion, not text embeddings)
- `server/src/airunner_services/api/routes/server_routes_specs.py` (route registration)
- `server/src/airunner_services/data/tenant.py:40-55`

**headlesscode (issue #147, Part B):**
- `src/codesearch/embedder.ts:90-230`
- `src/codesearch/ollama-embedder.ts` (full file, 206 lines — the template)
- `src/codesearch/types.ts:37`
- `src/codesearch/index.ts:196-255,384` (`loadIndexMetadata` bug at :219)
- `src/codesearch/cli.ts:44,50-61,97-113,141-157`
- `src/cli.ts:202-207`
- `src/tools/executor.ts:2203-2227`
- `src/codesearch/__tests__/backend-selection.test.ts`

**headlesscode (issue #148):**
- `.roomodes` (`researcher` mode added by commit `a27e57f`; `issue-filer`,
  `deepseek-reviewer` mode definitions)
- `src/orchestrator/reviewer.ts:120-124,137,168,180,226,236-243,266,338`
- `src/orchestrator/cli.ts:619-895,1260,1439,2337,2939`
- `src/orchestrator/resume.ts:831`
- `scripts/spawn-parallel-worktrees.sh`, `scripts/run-worker.sh:86`
- `src/orchestrator/watch.ts`
- `src/engine/loop.ts:1100,1116,1128,1143,3630-3771`
- `src/cli.ts:485-526`
- `docs/phase2-orchestration.md:204-223`
