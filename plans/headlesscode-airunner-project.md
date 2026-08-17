# headlesscode — new airunner project: stripped uwuchat clone for a coding chatbot

## Status: active work order (dispatch via headlesscode orchestrate)

This is the work order for creating a NEW airunner project `projects/headlesscode/`
in the airunner repo (`/home/joe/Projects/airunner`), so the user can stop using
VS Code for headlesscode work entirely: log into a website (like uwuchat.com),
register any folder on the workstation as a project, and launch headlesscode
sessions against it from the chat UI.

It is a STRIPPED clone of the existing `projects/uwuchat/` project: keep only
auth + chat-with-system-bot + the headlesscode integration (project registry,
session launch, live session cards, mid-session messaging, code-mode toggle).
Strip gems/gacha/economy/rooms/roleplay-chatbots/email/spotify/steam/calendar/
journal/newspaper/weather/onboarding/subscriptions/user-profiles/i18n.

CRITICAL provider requirement: DeepSeek must route through the **deepseek
provider on OpenRouter** (`provider.order: ["deepseek"]`), NOT DeepInfra
(`["deepinfra"]`) — see the provider section below.

All paths below are relative to `/home/joe/Projects/airunner`. Every citation
was verified against current file content.

## Architecture recap (what the clone needs to reuse)

- Airunner framework = React client (`client/`) + Python FastAPI server
  (`server/src/airunner_services`). Projects overlay both via
  `projects/<name>/server` (settings, pipeline, routes, models, tasks, tools)
  and `projects/<name>/client` (React overlay selected by `VITE_PROJECT`).
- Active project = `AIRUNNER_PROJECT` (server) + `VITE_PROJECT` (client).
  The server settings overlay loader reads `projects/<project>/server/conf/settings.py`
  (`server/src/airunner_services/conf/__init__.py:51-57`), and the pipeline
  loader reads `projects/<project>/server/ai_pipeline.py` (PIPELINE_CONFIG)
  or `llm_routing.py` (MODEL_ROUTING)
  (`server/src/airunner_services/llm/pipeline_loader.py:42-60`).
- Routes are registered from a GLOBAL spec table that hardcodes
  `projects.uwuchat.server.*` module paths:
  - `server/src/airunner_services/api/server_routes_specs.py:143-249`
  - `server/src/airunner_services/api/server_routes_specs_2.py:8-19`
  - Loader: `server/src/airunner_services/api/server_routes.py:49-68`
    (`_safe_import_router` swallows ImportError → missing modules are skipped,
    so the framework boots without a project's routes).
- `server/src/airunner_services/api/server.py` lifespan (lines 179-284)
  hardcodes `projects.uwuchat.server.*` imports for the headlesscode WS
  forwarder, uwu_creation forwarder, email sync signals, and embedding
  recovery. The headlesscode-project clone needs its OWN project-aware
  forwarder wiring (or an active-project lookup), not the uwuchat one.
- `server/src/airunner_services/api/server_routes.py:58-68` registers
  `projects.uwuchat.server.security` guard hooks unconditionally.

## What already exists in uwuchat (the source to copy + strip)

The uwuchat project already has the COMPLETE headlesscode integration:

Server (`projects/uwuchat/server/`):
- `headlesscode_client.py` (157 lines) — HTTP client for the dashboard control
  plane (`/api/session/start`, `/events`, `/pause|resume|answer`, `/message`),
  base URL `HEADLESSCODE_DASHBOARD_URL` default `http://127.0.0.1:4390`,
  bearer token `HEADLESSCODE_DASHBOARD_TOKEN`.
- `headlesscode_service.py` (218 lines) — account-scoped project registry +
  session CRUD (list/create/update/delete projects, session detail, forward
  mid-session message).
- `headlesscode_card.py` (97 lines) — appends `headlesscode_session` card
  entries to conversations (client renders these as live session cards).
- `headlesscode_polling.py` (187 lines) — per-session event-poll helpers
  (load context, persist new events with chat-block grouping, advance cursor,
  status transitions, Redis outbox append).
- `headlesscode_ws_forwarder.py` — drains the Redis outbox into the
  `/api/v1/events` WebSocket (started from the server lifespan).
- `headlesscode_event_store.py` (59 lines) — Redis DB outbox
  (`hc:event:outbox`).
- `headlesscode_chat_grouping.py` — event → chat-block kind mapping.
- `routes/headlesscode_routes.py` (128 lines) — FastAPI router, mounted at
  `/api/v1/uwuchat/headlesscode` (specs:245-249); gate `require_auth`.
- `routes/headlesscode_rpc.py` (148 lines) — WS-RPC handlers registered via
  `@_rpc_register("GET|POST|PATCH|DELETE", "/api/v1/uwuchat/headlesscode/...")`.
- `routes/_headlesscode_schemas.py` — pydantic in/out schemas.
- `models/headlesscode_project.py` (30 lines), `headlesscode_session.py`,
  `headlesscode_session_event.py` — SQLAlchemy models. Tables already exist
  via `server/src/airunner_services/database/alembic/versions/f2b3c13e6a26_create_headlesscode_tables.py`
  (created 2026-08-05, committed). REUSE these tables (same names).
- `tasks/headlesscode_tasks.py` (247 lines) — Celery launch task
  (`launch_headlesscode_session_task`), idempotency via Redis marker.
- `tasks/headlesscode_poll_tasks.py` — Celery poll task driving the event
  relay.
- `tools/code_tools/launch_session.py` (240 lines) — LLM tool
  `launch_headlesscode_session` (confirmation gate + credits check +
  enqueue launch).
- `tools/code_tools/launch_confirmation.py` — confirmation/idempotency keys.
- `code_mode_routes.py` (71 lines) + `code_mode_service.py` (23 lines) —
  per-conversation code-mode toggle (superuser-gated GET/PUT
  `/api/v1/uwuchat/code-mode/{id}`).
- `quota_*`, `code_credits_*` — spend metering. KEEP only if cheap; the
  launch tool calls `code_credits_service.has_credits`
  (`launch_session.py:24`). For a single-user local tool, simplify: make the
  tool skip the credits gate OR keep code_credits minimal. Decision: keep the
  code-credits module (it already exists and is tested) but do NOT wire
  Stripe/admin UI — leave `has_credits` as-is (local admin can top up), so
  no behavioral change to the launch tool.
- `seed.py` (73 lines) — `ensure_system_bot` creates the system bot (for the
  clone: rename personality to a coding assistant).
- `system_bot_prompt.py` (249 lines) — system prompt for the UwU assistant.
  For the clone, REWRITE as a coding-assistant system prompt (no roleplay,
  no memory narration; brief, tool-usage focused).

Client (`projects/uwuchat/client/`):
- `api/headlesscode.ts` (99 lines) — project registry + session detail +
  mid-session message API (BASE `/api/v1/uwuchat/headlesscode`).
- `api/client-base.ts` — framework file (`client/src/api/client-base.ts`),
  the `request()` WS-RPC helper. Reuse, do not copy.
- `hooks/useCodeMode.ts` (102 lines) — read/set code-mode toggle.
- `components/chat/CodeModeToggle.tsx` — the code-mode UI toggle.
- Session-card rendering: the client renders `headlesscode_session`
  metadata entries from `api/headlesscode.ts`'s session detail / events.
- `App.tsx` (437 lines) — the full app shell (auth, layout, chat, setup,
  subscribe, profile...). For the clone, write a STRIPPED App.tsx:
  auth routes + chat view + headlesscode session cards + project registry
  settings + code mode toggle. Remove gems/gacha/economy/rooms/onboarding/
  setup wizard/subscriptions/user profiles/i18n.
- Auth pages come from the auth extension:
  `extensions/auth/client/routes.tsx` (`/login`, `/register`, `/verify`,
  `/oauth/callback`) + `extensions/auth/client/Provider.tsx` (`useAuth`).

## What the clone must create (the actual work)

### A. New server project: `projects/headlesscode/server/`

Create the following, copying from uwuchat and rewriting every
`projects.uwuchat.server.*` import → `projects.headlesscode.server.*`
(grep `projects.uwuchat` across the copied files and fix ALL of them;
also rewrite the hardcoded `/api/v1/uwuchat/headlesscode` strings to
`/api/v1/headlesscode` in `headlesscode_routes.py` and
`headlesscode_rpc.py`, and `/api/v1/uwuchat/code-mode` → `/api/v1/headlesscode/code-mode`
in `code_mode_routes.py`):

- `conf/settings.py` — project overlay. Model it on
  `projects/uwuchat/server/conf/settings.py` (60 lines): `DEPLOYMENT="cloud"`,
  headlesscode dashboard URL/token from env (lines 47-52), PII masking on
  (line 59), RAG/analysis/summary/weather OFF (lines 17-20), mood OFF
  (we are not roleplay). NO guard model path (headlesscode is a tool, not a
  safety product) — but keep it harmless if unset.
- `ai_pipeline.py` — `PIPELINE_CONFIG` for the headlesscode chatbot. Use the
  same shape as `projects/uwuchat/server/ai_pipeline.py` (282 lines) but
  ONLY the keys the clone needs: `DIALOGUE`, `TOOL_CLASSIFICATION`,
  `TOOL_EXECUTION`, `SUMMARIZATION` (enabled False), `STATELESS`. All point
  at `DEEPSEEK_V4_FLASH_MODEL` (`deepseek/deepseek-v4-flash`,
  `server/src/airunner_services/conf/model_settings.py:28`) via
  `MODEL_PROVIDER` (openrouter). DIALOGUE max_tokens 2000.
- `llm_routing.py` — `MODEL_ROUTING` mirror (provider openrouter, model
  deepseek-v4-flash) as the fallback shape.
- `headlesscode_client.py`, `headlesscode_service.py`, `headlesscode_card.py`,
  `headlesscode_polling.py`, `headlesscode_ws_forwarder.py`,
  `headlesscode_event_store.py`, `headlesscode_chat_grouping.py` — copies.
- `routes/__init__.py`, `routes/headlesscode_routes.py`,
  `routes/headlesscode_rpc.py`, `routes/_headlesscode_schemas.py` — copies
  with path rewrites.
- `models/__init__.py`, `models/headlesscode_project.py`,
  `models/headlesscode_session.py`, `models/headlesscode_session_event.py` —
  copies. Models map to the EXISTING `headlesscode_*` tables (no migration).
- `tasks/__init__.py`, `tasks/headlesscode_tasks.py`,
  `tasks/headlesscode_poll_tasks.py` — copies.
- `tools/__init__.py`, `tools/code_tools/__init__.py`,
  `tools/code_tools/launch_session.py`, `tools/code_tools/launch_confirmation.py` —
  copies.
- `code_mode_routes.py`, `code_mode_service.py` — copies (path rewrite).
- `seed.py` — copy but change the bot name/personality to a coding assistant
  (e.g. name "Halo" or "Headless"; `_SYSTEM_BOT_PERSONALITY` → concise,
  technical, tool-using assistant; identity_core bio → headlesscode
  assistant).
- `system_bot_prompt.py` — NEW, coding-assistant system prompt. NO roleplay,
  NO email/calendar/knowledge memory blocks (the uwuchat prompt at
  `projects/uwuchat/server/system_bot_prompt.py:82-114` narrates personal/
  email knowledge — DROP those). Keep: identity, the launch-tool usage
  instruction (tell the user to register a project first via settings →
  projects, then ask it to "work on <project>"; the tool
  `launch_headlesscode_session` handles the rest), and the code-mode toggle
  mention. Do NOT import `prompt_rules.py`/`system_bot_examples.py` unless
  trivially adapted.
- Tests: copy `projects/uwuchat/server/tests/test_headlesscode_*.py`
  (client, service via routes, tasks, poll_tasks, event_store, card,
  chat_grouping, code_mode) and rewrite imports/paths. Keep the fakes
  (`tests/fakes_headlesscode.py`) and fixture patterns. Update `conftest.py`
  if the uwuchat one sets `AIRUNNER_PROJECT=uwuchat` — the clone tests must
  set `AIRUNNER_PROJECT=headlesscode`.

### B. New client project: `projects/headlesscode/client/`

- `meta.json` — title/siteName "headlesscode" (uwuchat's is at
  `projects/uwuchat/client/meta.json`).
- `App.tsx` — STRIPPED shell (uwuchat's is 437 lines; keep only what's
  needed): use the auth extension's providers + routes
  (`extensions/auth/client/routes.tsx`), a chat view for the system bot,
  the headlesscode session-card rendering, a project-registry settings panel,
  and the code-mode toggle. No gems/gacha/economy/rooms/onboarding/setup
  wizard/subscriptions/profile/i18n.
- `api/headlesscode.ts` — copy, BASE → `/api/v1/headlesscode`.
- `hooks/useCodeMode.ts` — copy (paths → `/api/v1/headlesscode/code-mode`).
- `components/chat/CodeModeToggle.tsx` — copy.
- Any chat/session-card components required by App.tsx, adapted from
  `projects/uwuchat/client/components/chat/` — keep it minimal (MessageList,
  session card, streaming status). Do NOT pull in gems/gacha components.
- The framework `client/src/api/client-base.ts` provides `request()` (WS RPC)
  — reuse it, don't copy.

### C. Framework wiring (server/src/airunner_services/)

1. Route registration: add headlesscode-project entries to
   `server/src/airunner_services/api/server_routes_specs.py` (or
   `server_routes_specs_2.py`, which appends onto `_ROUTE_SPECS` at
   `server_routes_specs.py:6`):
   - `("headlesscode_routes", "projects.headlesscode.server.routes.headlesscode_routes", {"prefix": "/api/v1/headlesscode", "tags": ["headlesscode"]}, [])`
   - `("headlesscode_code_mode", "projects.headlesscode.server.code_mode_routes", {"prefix": "/api/v1/headlesscode", "tags": ["headlesscode"]}, [])`
   - RPC registration happens on import of `headlesscode_rpc.py` (import it
     by name inside `headlesscode_routes.py` like the uwuchat one does at
     `headlesscode_routes.py:127`).
   Do NOT remove uwuchat entries — the two projects coexist.
2. `server/src/airunner_services/api/server.py` lifespan: make the headlesscode
   WS forwarder resolve the ACTIVE project instead of hardcoding uwuchat
   (lines 179-197): try `projects.<AIRUNNER_PROJECT>.server.headlesscode_ws_forwarder`
   first, then fall back to the current uwuchat import. The uwu_creation /
   email / embedding imports can stay uwuchat-only (ImportError-guarded).
3. Security guards (`server_routes.py:58-68`): keep uwuchat guards as-is;
   they are ImportError-guarded and harmless to the headlesscode project.

### D. Provider change (IMPORTANT — DeepSeek via deepseek provider, not DeepInfra)

- `server/src/airunner_services/cloud/llm/model_builders.py:96-124`
  `_provider_order_for_model()` currently returns `["deepinfra"]` for any
  `deepseek/*` model (line 122-123). Make it project-aware: when
  `AIRUNNER_PROJECT` (env) is `headlesscode`, return `["deepseek"]` for
  `deepseek/*`; otherwise keep `["deepinfra"]`. Read the env var directly
  (`os.environ.get("AIRUNNER_PROJECT")`) — do not import settings (avoids
  import cycles). This is THE user-visible provider requirement.
- `server/src/airunner_services/llm/openrouter_catalog.py:30-38`
  `PINNED_PROVIDER_PRICING["deepseek/deepseek-v4-flash"]` pins pricing to
  DeepInfra's rates. Leave as-is IF the deepseek-provider price matches; if
  the worker can verify the deepseek provider's per-token rate differs, note
  it in the PR description but do NOT change pricing without the repo owner —
  pricing is display-only for cost accounting.

### E. Run config (implemented 2026-08-16 — the website is LIVE)

An isolated second stack (`COMPOSE_PROJECT_NAME=airunner-hc`) runs the
headlesscode website without touching the running uwuchat dev stack:

- `.env.headlesscode` + `docker-compose.headlesscode-local.yml` (both at
  the airunner repo root): server on **8081**, Vite client on **5174**,
  postgres on 5435, `AIRUNNER_PROJECT=headlesscode`,
  `VITE_PROJECT=headlesscode`, `VITE_DEPLOYMENT=cloud`,
  `AIRUNNER_EXTENSIONS=extensions.auth.config`, `AIRUNNER_SIGNUP_MODE=open`
  (no waitlist gate — the clone stripped the setup wizard), auth ON
  (`AIRUNNER_INSECURE_NO_AUTH=0` so the login page is real).
- The `headlesscode` dashboard runs as a SIDECAR sharing the server's
  network namespace (`network_mode: service:server`, image
  `headlesscode:0.1.0`, command `headlesscode dashboard --port 4390`),
  so the server reaches it at `http://127.0.0.1:4390` — the documented
  localhost-only contract (see
  `extensions/docker/docker-compose.headlesscode.yml`).
- Bring-up: `docker compose --env-file .env.headlesscode -f docker-compose.yml -f docker-compose.headlesscode-local.yml up -d db airunner-redis server headlesscode client celery celery-sync celery-beat`
- **Login URL: http://localhost:5174** (register an account — signup is
  open — then log in). API: http://localhost:8081/api/v1/health.

Two runtime bugs found during bring-up and fixed on master (commit
`ea7efe85c`):
- `projects/headlesscode/server/models/__init__.py` `__all__` included
  `CodeCreditTransaction` (a public-schema table), so the tenant-schema
  repair in `setup_migrations._extend_with_project_models` tried to
  CREATE it per tenant → `DuplicateTable` 500 on every project API call.
  Fixed by excluding it from `__all__` (direct imports unchanged).
- `create_project` FK targets `users.id`, but the stripped clone has no
  setup wizard to create the tenant `users` row → `ForeignKeyViolation`
  on project create. Fixed by lazily creating the row in
  `projects/headlesscode/server/headlesscode_service.py` (mirrors the
  OAuth path in `extensions/auth/server/routes.py:1998`).

## Verification bar

- `cd /home/joe/Projects/airunner && grep -rn "projects.uwuchat" projects/headlesscode/` → no hits (all rewritten).
- Server: run the new project's tests — `docker compose exec server python -m pytest projects/headlesscode/server/tests/ -q` (or the docker-run boot check pattern from the airunner convention) with `AIRUNNER_PROJECT=headlesscode`. Framework must boot with `register_routes` including the new routes (use the airunner convention boot check).
- Provider: assert `_provider_order_for_model("deepseek/deepseek-v4-flash")` returns `["deepseek"]` when `AIRUNNER_PROJECT=headlesscode` and `["deepinfra"]` otherwise.
- Client: `cd client && VITE_PROJECT=headlesscode npm run build` (or the repo's client build convention) — must compile.
- The full stack run + login is handled after the round merges (section E), not by workers.

## Dispatch

Dispatch via the headlesscode orchestrator against the airunner repo with
synthetic issues (`--issues-json`, no `--file-issues` — no real GitHub
writes): `cd /home/joe/Projects/airunner && scripts/headlesscode-orchestrate.sh --issues-json <this-plan-dir>/headlesscode-project-issues.json --max-iterations 150`. The airunner wrapper
exports `HEADLESSCODE_OPENROUTER_API_KEY` from airunner's `.env` and execs
`headlesscode orchestrate --repo /home/joe/Projects/airunner`.

Issue split (each becomes its own worktree):
- Issue 1: sections A + D (server project + provider change).
- Issue 2: section C (framework wiring).
- Issue 3: section B (client project).
