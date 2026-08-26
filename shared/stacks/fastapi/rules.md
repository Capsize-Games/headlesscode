# Stack rules: FastAPI

Applies when the target project uses FastAPI (`fastapi` in Python dependencies).
These are FastAPI-specific conventions and footguns on top of the project's own
rules.

## Routes

- Test every new or changed route through the ACTUAL ASGI app — `TestClient`
  (`fastapi.testclient`) or `httpx.AsyncClient` over `ASGITransport` — never
  just the handler function in isolation. A route can be wired wrong (missing
  from the router, wrong prefix/method) while the handler function itself is
  correct.
- Before adding a route that needs auth/db/session access, find the project's
  dependency-injection conventions (`Depends(...)`) and reuse its existing
  scoping helpers (e.g. a tenant/account-resolution dependency or mixin).
  Inventing a different pattern produces a route that looks right but bypasses
  the project's scoping layer (tenant isolation, account checks).
- After adding or changing a route, re-run the project's boot check if one
  exists (e.g. an assertion on the exact route count). A route that silently
  fails to register is caught only by an explicit count/list check, not by
  "the server started".

## Pydantic models

- Before changing a request/response model field, check whether the schema is
  shared with client-generated types (OpenAPI-driven codegen). A field change
  without the matching client update silently breaks the frontend contract.
- Return the project's response models explicitly rather than leaking internal
  ORM objects or ad-hoc dicts where a schema is expected.
