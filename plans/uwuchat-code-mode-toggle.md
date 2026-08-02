# UwUChat code-mode toggle — explicit admin on/off switch, no intent classification

## Status: scoped for dispatch (2026-08-02) — self-contained, no other plan doc required

## Who you are working on this for

You are implementing this against the `airunner` repository
(`~/Projects/airunner`) — a multi-tenant AI chat framework. UwUChat is one
product built on it, living under `projects/uwuchat/{server,client}`. Read
`CLAUDE.md` at the repo root in full before touching anything — it defines a
hard framework/project separation: framework code goes in `server/src/
airunner_services/` or `client/src/`, UwUChat-only behavior goes under
`projects/uwuchat/`. This task is 100% UwUChat-specific — nothing here
belongs in framework code.

This is item 2 of `plans/uwuchat-integration.md`'s Tier 1 build order (a
different repo's plan doc — you do not need to read it; everything required
is below). Tier 1 is a permanent, admin-only capability: an admin can point
a general coding-agent harness (headlesscode, a separate CLI project) at any
project and drive it from inside a UwUChat conversation with `uwu`. The
mode-switch decision has already been made and is **not open for
re-litigation**: this is an explicit on/off toggle the admin controls per
conversation, NOT automatic intent classification. Do not build or propose
classification logic.

## Verified current state (re-confirm before starting; report if anything
has drifted)

- `Conversation` (`server/src/airunner_services/database/models/
  conversation.py`) has a `user_data = Column(JSON, nullable=True)` column
  already used for ad-hoc per-conversation state with no migration per key —
  see `server/src/airunner_services/llm/mood/persistence.py` (writes
  `conversation.user_data["current_mood"]`) and
  `server/src/airunner_services/llm/managers/database_chat_message_history.py`
  (pending-metadata keys prefixed `_pending_`). Follow this exact pattern:
  store the toggle as a key inside `user_data`, no schema migration needed.
- `extensions/auth/server/dependencies.py` has `require_superuser` (FastAPI
  dependency, 401 unauthenticated / 403 non-admin, returns `account_id`) —
  the established pattern for admin-gated endpoints. See
  `extensions/auth/server/routes_admin.py` (every route gated by
  `Depends(require_superuser)`) and `stripe_routes.py`'s admin endpoints for
  usage examples.
- `projects/uwuchat/server/quota_routes.py` is the closest existing
  precedent for a small, single-purpose UwUChat route module: one router,
  mounted via a registration list in `server/src/airunner_services/api/
  server_routes.py` (search that file for `"projects.uwuchat.server.
  quota_routes"` around line 232-233 — copy the exact tuple shape used
  there, including the `{"prefix": ..., "tags": [...]}` dict form used by
  `journal_routes`/`calendar_routes` a few lines below it).
- `ToolCategory.CODE` exists in `server/src/airunner_services/llm/core/
  tool_registry.py` with zero tools registered under it — confirmed via
  grep, nothing else touches it. This task does NOT add any CODE-category
  tools; that's separate follow-on work (Tier 1 build-order item 3). This
  task only adds the toggle state and its enforcement point.
- Confirm `Account.is_superuser` (`extensions/auth/server/models.py`) is
  still the admin flag before writing this — re-grep, don't assume the
  investigation above hasn't drifted since 2026-08-02.

## What to build

### 1. Toggle state: `conversation.user_data["code_mode"]` (boolean)

No new column, no migration. `True` means code mode is ON for that
conversation; absent or `False` means OFF (normal chat).

### 2. Admin-only API to read/set the toggle

New file `projects/uwuchat/server/code_mode_routes.py`, same shape as
`quota_routes.py`:

```python
router = APIRouter()

@router.get("/code-mode/{conversation_id}")
async def get_code_mode(
    conversation_id: int,
    account_id: int = Depends(require_superuser),
) -> dict:  # {"code_mode": bool}
    ...

@router.put("/code-mode/{conversation_id}")
async def set_code_mode(
    conversation_id: int,
    enabled: bool,  # request body, e.g. {"enabled": true}
    account_id: int = Depends(require_superuser),
) -> dict:  # {"code_mode": bool}
    ...
```

Both endpoints require `require_superuser` — this is the load-bearing
security property of the whole feature (code mode implies the harness can
eventually run arbitrary `execute_command`; it must be categorically
unreachable by non-admin accounts). Additionally verify the conversation's
owning account (`Conversation.user_id`) matches an admin account before
allowing the toggle — do not allow one admin to flip the toggle on another
account's conversation; 404 if the conversation doesn't exist, 403 if it
belongs to a different (even if also-admin) account, matching this
codebase's existing ownership-check convention (grep
`extensions/auth/server/routes_admin.py` and any conversation-scoped route
for the exact 403-vs-404 precedent already used and mirror it exactly rather
than inventing new semantics).

Mount at `/api/v1/uwuchat` alongside `journal_routes`/`calendar_routes` (see
`server_routes.py` registration list) — reuse the existing `/api/v1/uwuchat`
prefix group rather than inventing a new one, so the endpoints land at
`/api/v1/uwuchat/code-mode/{conversation_id}`.

### 3. Server-side enforcement point (read side)

Add a small helper, `projects/uwuchat/server/code_mode_service.py`:

```python
def is_code_mode_enabled(conversation: Conversation) -> bool:
    return bool((conversation.user_data or {}).get("code_mode"))
```

Call this from wherever the ai_pipeline decides how to route a turn
(`projects/uwuchat/server/ai_pipeline.py`) — for THIS task, only wire it as
a **read-only signal that is logged/available**, not as a live routing
branch into architect/orchestrator behavior (that's Tier 1 build-order item
3, a separate task — ToolCategory.CODE has zero tools today, so there is
nothing to route to yet). Concretely: add a debug-level log line or a
pass-through field on whatever per-turn context object `ai_pipeline.py`
already threads through the pipeline stages, so the next task (wiring
`ToolCategory.CODE` tools) has a ready-made place to branch from. Do not
invent new pipeline stages or new routing behavior beyond that — this task
is scoped to "the toggle exists, is admin-gated, is persisted, and is
readable by the pipeline," not "code mode does anything yet."

### 4. Client-side toggle UI

UwUChat-specific — goes under `projects/uwuchat/client/`, never under
`client/src/`. Find the settings/admin panel pattern UwUChat already uses
(grep `projects/uwuchat/client/` for an existing admin-only settings control
— e.g. search for how `is_superuser`/admin gating is checked client-side
today, and for any existing per-conversation toggle control to match
styling/interaction conventions) and add a "Code Mode" toggle visible only
to admin accounts, scoped to the currently-open conversation, backed by the
GET/PUT endpoints above. Follow this repo's JS/React rules from
`CLAUDE.md`: functional component/hook, ≤250 lines, TypeScript types for
props, no direct `localStorage`/`IndexedDB` access (this is server state,
fetched via the API — no client storage involved at all here).

## What NOT to do

- Do not build any form of automatic coding-intent classification. The
  toggle is the entire mechanism — this is a deliberate, already-made
  simplification, not a placeholder for future classification work.
- Do not add any `ToolCategory.CODE` tools, do not call out to
  headlesscode, do not add an architect/orchestrator tool. Those are
  separate, larger follow-on tasks (Tier 1 build-order items 1 and 3) that
  depend on a real compute host decision this task does not make.
- Do not add a migration or new database column — `user_data` already
  supports this without one.
- Do not expose the toggle or its endpoints to non-admin accounts in any
  form, including read access. A non-admin should get 403/404, never a
  200 with `code_mode: false`.
- Do not touch `client/src/` for anything UwUChat-specific — add or edit
  files only under `projects/uwuchat/client/`.

## Tests

- `projects/uwuchat/server/tests/` (follow this directory's existing
  pytest conventions — check an existing test file there for fixtures/
  session-scoping patterns before writing new ones):
  - GET/PUT round-trip: toggle on, GET reflects `true`; toggle off, GET
    reflects `false`; default (never set) is `false`.
  - 401 with no auth, 403 for a non-superuser account, 403 or 404 (whichever
    matches this codebase's existing convention, per the investigation note
    above) when a superuser targets a conversation they don't own.
  - `is_code_mode_enabled()` unit test: `True`/`False`/key-absent cases.
- Client: a component test for the toggle control if this project has an
  existing component-test convention under `projects/uwuchat/client/`
  (check for `.test.tsx` files nearby before adding a new test pattern from
  scratch).

## Verification checklist

1. `docker compose exec server python scripts/run_tests.py` — new tests
   plus full suite green (per `CLAUDE.md`'s testing section — do not run
   Python directly on the host, it isn't installed there).
2. Manually confirm (read-only inspection is fine per `CLAUDE.md`'s Testing
   Boundary — the user tests runtime behavior themselves) that the route
   registration tuple you added matches the exact shape
   `server_routes.py` expects, by reading the surrounding entries, not by
   guessing.
3. Confirm no framework file under `client/src/` or `server/src/
   airunner_services/` (outside the one small pipeline hook in item 3) was
   modified — `git diff --stat` should show changes concentrated under
   `projects/uwuchat/`.

## What to report back

- Files added/changed.
- Exact 403-vs-404 convention you found and matched for the
  wrong-account-owns-conversation case, and where you found the precedent.
- Where in `ai_pipeline.py` you wired the read-only `is_code_mode_enabled`
  signal, and what it currently does with it (should be "nothing yet but
  logged/threaded through," per item 3).
- Test results (paste real output).
- Any deviation from this spec, and why.
