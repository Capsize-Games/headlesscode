# Memory — UwUChat API contract (Phase 3)

This document defines the **harness-side client contract** for the Phase 3
memory subsystem and the **expected AIRunner/UwUChat REST endpoints** that will
implement it. The harness ships with a fully working local backend
(`LocalMemoryStore`) and a client stub (`UwUChatMemoryStore`) that implements
the same `MemoryStore` interface against these endpoints.

> **Status:** the AIRunner/UwUChat endpoints DO NOT EXIST yet. This document is
> the agreed contract for that work, and `UwUChatMemoryStore` throws
> `UwUChatMemoryError("not implemented — awaiting AIRunner endpoint")` until a
> base URL (and token) are configured.

---

## 1. Harness-side client contract

The harness depends only on the `MemoryStore` interface
([`src/memory/types.ts`](../src/memory/types.ts)):

```ts
interface MemoryStore {
  listFacts(project: string): Promise<MemoryFact[]>
  addFact(project: string, factInput: FactInput): Promise<MemoryFact>
  queryRecall(project: string, query: string, limit?: number): Promise<RecallResult>
  recordSession(project: string, summary: SessionSummary): Promise<void>
  listSessions(project: string): Promise<SessionSummary[]>
  summarize?(project: string, options?: { maxEntries?: number }): Promise<string>
}
```

with:

```ts
interface MemoryFact {
  id: string; project: string
  kind: "convention" | "decision" | "failure" | "knowledge"
  content: string; tags: string[]; source?: string; createdAt: string
}
interface SessionSummary {
  id: string; project: string; task: string; mode?: string
  outcome: "success" | "failure"; summary: string
  facts: MemoryFact[]; filesTouched: string[]; commandsRun: string[]; createdAt: string
}
interface RecallResult {
  facts: ScoredFact[]        // MemoryFact & { score?: number }
  summaries: ScoredSessionSummary[]  // SessionSummary & { score?: number }
}
```

`LocalMemoryStore` implements this today with plain fs + JSONL. `UwUChatMemoryStore`
implements the exact same interface over HTTP — callers cannot tell which
backend is in use.

---

## 2. Expected AIRunner/UwUChat REST endpoints

Base URL: `UWUCHAT_BASE_URL` (env), path prefix `/api/v1/harness/memory/…`.

| Method | Path | Harness method | Purpose |
|--------|------|----------------|---------|
| `GET`    | `/api/v1/harness/memory/facts?project=<p>`            | `listFacts`      | List all facts for a project |
| `POST`   | `/api/v1/harness/memory/record-fact`                  | `addFact`        | Record a fact (idempotent by content) |
| `POST`   | `/api/v1/harness/memory/query-recall`                 | `queryRecall`    | Semantic recall over facts + summaries |
| `POST`   | `/api/v1/harness/memory/record-session`               | `recordSession`  | Persist a completed session summary |
| `GET`    | `/api/v1/harness/memory/sessions?project=<p>`         | `listSessions`   | List session summaries for a project |
| `GET`    | `/api/v1/harness/memory/summaries?project=<p>&maxEntries=<n>` | `summarize` | Rolling recap (markdown) of recent sessions |

### 2.1 `POST /api/v1/harness/memory/record-fact`

Request:
```json
{
  "project": "airunner",
  "fact": { "kind": "convention", "content": "always run tests before pushing", "tags": ["testing"], "source": "session:abc123" }
}
```
Response `200`:
```json
{ "fact": { "id": "fact_1a2b3c4d", "project": "airunner", "kind": "convention", "content": "…", "tags": ["testing", "convention"], "source": "…", "createdAt": "2026-08-01T00:00:00.000Z" } }
```
`fact.id`, `fact.project`, `fact.createdAt` are server-assigned. **Idempotent:**
the same `content` for the same `project` returns the existing fact (no
duplicate row). 409/200-with-existing both acceptable; the client treats a
non-error 2xx as success and never stores a duplicate.

### 2.2 `GET /api/v1/harness/memory/facts?project=<p>`

Response `200`:
```json
{ "facts": [ /* MemoryFact[] */ ] }
```

### 2.3 `POST /api/v1/harness/memory/query-recall`

Request:
```json
{ "project": "airunner", "query": "retry on 429", "limit": 5 }
```
Response `200`:
```json
{
  "facts":     [ { "id": "…", "project": "airunner", "kind": "failure", "content": "…", "score": 0.87 } ],
  "summaries": [ { "id": "…", "project": "airunner", "task": "…", "outcome": "success", "summary": "…", "score": 0.62 } ]
}
```
Ordering MUST be deterministic: relevance score desc, then `createdAt` desc.
`score` is optional; a missing score must not reorder results. Empty stores
return `{ "facts": [], "summaries": [] }`. Embedding computation runs
harness-side (see §4); the server only persists/queries.

### 2.4 `POST /api/v1/harness/memory/record-session`

Request:
```json
{
  "project": "airunner",
  "session": {
    "id": "summary_abc", "task": "fix the retry bug", "mode": "code",
    "outcome": "success", "summary": "…", "facts": [ /* MemoryFact[] */ ],
    "filesTouched": ["src/client.ts"], "commandsRun": ["npm test"], "createdAt": "…"
  }
}
```
Response `200`: `{ "ok": true }`. Idempotent by `session.id` (re-posting the
same id is a no-op).

### 2.5 `GET /api/v1/harness/memory/sessions?project=<p>`

Response `200`: `{ "sessions": [ /* SessionSummary[] */ ] }`

### 2.6 `GET /api/v1/harness/memory/summaries?project=<p>&maxEntries=<n>`

Response `200`: `{ "summary": "## Rolling session recap …" }` (markdown recap
of the most recent `maxEntries` sessions for the project — the AgentMemory
equivalent; no raw history is ever returned).

---

## 3. Auth (scoped token)

- Every endpoint requires `Authorization: Bearer <scoped-token>`.
- The token is a **service-scoped** credential minted for the harness, NOT an
  end-user session token. It grants access ONLY to the harness memory schema
  (see §5). It must be revocable independently of any customer tenant access.
- Transport: HTTPS in any non-local deployment.
- `UwUChatMemoryStore` reads the token from `UWUCHAT_TOKEN` (env) or the
  constructor option, and sends `Authorization: Bearer <token>` on every
  request. Non-2xx responses surface as typed `UwUChatMemoryError`
  (`status` + body excerpt).

## 4. Where embedding runs

Embedding is computed **harness-side** (local embedding model / the Phase 3
`createLocalEmbedder` stand-in), then the harness calls these endpoints only to
**persist/query**. The AIRunner side must NOT need an embedding model, must not
route any embedding computation to the cloud, and must accept
`queryRecall` with a free-form `query` string (it is the harness that embeds).
No cloud routing, no rate limiter, no encryption requirement — this is an
internal dev tool's knowledge, not customer data.

## 5. Data isolation — HARD REQUIREMENT

The harness memory is **knowledge about the harness's own codebase work**
("facts about a codebase and its past decisions"), NOT tenant/user data. The
AIRunner implementation MUST:

1. **Dedicated schema/service.** Harness facts/sessions live in a schema (or
   store) dedicated to harness knowledge — never a table or collection that any
   customer tenant route reads or writes, and never tenant-scoped tables bolted
   onto. Per-project scoping is by `project` (a repo name), NOT by tenant/user.
2. **Never reachable via tenant routes.** No existing customer-facing endpoint
   may be able to query or write this store, and these endpoints must not be
   reachable through any tenant-scoped path. This is a genuine
   security-review item (tenant-isolation bugs are this project's most
   recurring incident category).
3. **No FHE/encryption for the harness's own knowledge** (internal dev tool,
   not customer data) — but the new API surface itself still gets normal
   auth/authz scrutiny since it is a new way to reach the AIRunner server.
4. **No cloud routing / no rate limiter** for this internal memory path.

## 6. `UwUChatMemoryStore` stub behaviour

- Without a base URL (no `UWUCHAT_BASE_URL` / `baseUrl` option): every method
  throws `UwUChatMemoryError("UwUChatMemoryStore: not implemented — awaiting
  AIRunner endpoint (set UWUCHAT_BASE_URL and, if required, UWUCHAT_TOKEN)")`.
- With a base URL: methods fetch the endpoints above using native `fetch`,
  sending `Content-Type: application/json` and the Bearer token when set.
- It is unit-tested for URL/path construction + auth headers only (no live
  server required).
