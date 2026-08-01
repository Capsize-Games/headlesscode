# Dashboard: workspace file browser + permissions settings UI — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. Two
related, similarly-scoped browser-parity gaps, both extending the dashboard
that already exists (`src/dashboard/`):

1. No way to browse a workspace's files in the browser (VS Code obviously
   has a file tree; the headless dashboard has none).
2. No way to configure command allow/deny + protected-file permissions from
   the browser — `.headlesscode/permissions.json` is CLI-flag/env/JSON-file
   only today, unlike `.headlesscode/mode-models.json`, which already got a
   real dashboard settings page (`plans/mode-model-assignment.md`, merged —
   re-read its final state as your template for how a settings page in this
   dashboard should look/behave).

Match this project's established style: ZERO new UI/framework dependencies
(plain HTML/CSS/vanilla JS, no build step); no test framework (plain
`tsx`-run test files); `npx tsc --noEmit` and `npm test` must stay green;
re-run every e2e suite under `scripts/e2e*/run.sh`.

## Note on concurrent work

`plans/dashboard-chat-ui.md` and `plans/dashboard-checkpoint-diff-ui.md` may
be running at the same time — all three touch `src/dashboard/page.ts` and
possibly `server.ts`. Real conflict risk. If you hit one, re-read the other
tasks' actually-merged final state before resolving, and prefer additive
changes over restructuring shared code.

## Part A — file browser

### What to build

- `GET /api/files?repo=<path>&dir=<relative-path>` — list a directory's
  entries (name, type file/dir, size) for a given workspace. Reuse
  `list_files`'s existing implementation logic
  (`src/tools/executor.ts`'s `listFilesHandler`) rather than
  reimplementing directory listing/`.gitignore` handling from scratch —
  check whether it's directly reusable or needs a thin adapter.
- `GET /api/files/content?repo=<path>&file=<relative-path>` — return a
  single file's content (text only; for binary/large files, return a clear
  "not previewable" response rather than dumping raw bytes into a JSON
  response — check `MAX_RESULT_CHARS`/similar existing size-cap conventions
  in this project and apply something equivalent here).
- **Path-traversal safety is non-negotiable.** Reuse
  `resolveWithinWorkspace`/the `PathTraversalError` guard already
  implemented in `src/tools/executor.ts` — do not reimplement path
  containment checking for this new HTTP-facing surface; a bug here would
  be a real directory-traversal vulnerability on a locally-running HTTP
  server. Every new route in this section MUST go through that existing
  guard.
- Dashboard UI: a simple collapsible directory tree (plain HTML/JS, no
  library) in a new panel, clicking a file shows its content in a read-only
  text view. Read-only in this pass — do not add file editing from the
  browser, that's a much bigger, higher-risk surface (arbitrary file writes
  from an unauthenticated-by-default local HTTP server) explicitly out of
  scope here.

## Part B — permissions settings UI

### What to build, following `mode-model-assignment`'s established pattern exactly

- `GET /api/settings/permissions?repo=<path>` — current
  `.headlesscode/permissions.json` content (or the resolved built-in
  defaults, clearly labeled as defaults-not-yet-customized, if no file
  exists — check how the mode-models settings page distinguishes "no file
  yet" from "file with content" and mirror that UX).
- `POST /api/settings/permissions?repo=<path>` — validate + write
  `.headlesscode/permissions.json`. Validation MUST reuse
  `src/permissions/config.ts`'s existing parsing/validation logic (the
  "fail loudly on malformed input" idiom already established there) — do
  not build a second, parallel validator that could drift from what the
  CLI/env path actually enforces.
- **This is a genuinely sensitive settings surface** — a malicious or
  careless POST here could weaken command restrictions or unprotect
  `.env`/credential files for every future session in this workspace. This
  route MUST be gated by the same optional bearer-token mechanism as other
  `/api/session/*`/checkpoint-restore POSTs (extend the existing gate's
  path-matching, don't build a separate one) — and consider (your call,
  document the reasoning either way) whether this one should default to
  requiring the token even when the general `/api/session/*` gate is
  unconfigured, given how much more consequential a weakened permissions
  file is than starting a session.
- Dashboard UI panel (new tab/section, following the existing mode-models
  settings page's layout conventions in `page.ts`): view + edit
  allowed/denied command lists, protected-file globs, and the
  `allowProtectedWrites` escape hatch, with the same clear
  validation-error-on-save behavior the mode-models settings page already
  has (check how it surfaces a malformed save attempt to the user and match
  that UX).

## What NOT to do

- Do not add file editing/writing from the browser (Part A) — read-only
  only, explicitly out of scope.
- Do not reimplement path-traversal guarding, directory listing, or
  permissions validation — reuse the existing, already-tested logic in each
  case.
- Do not add a UI framework or build step.
- Do not ship the permissions settings POST without the bearer-token gate.

## Tests

- File browser: path-traversal attempts against the new routes are refused
  (reuse/extend the existing `PathTraversalError` test fixtures from
  `src/tools/__tests__/` for the pattern), normal directory listing and
  file-content retrieval work, oversized/binary files are handled per your
  chosen cap rather than dumped raw.
- Permissions settings: `GET` returns current config or clearly-labeled
  defaults; `POST` with valid config writes the file and it's readable via
  `resolvePermissions` afterward (prove the round-trip actually affects
  real permission resolution, not just that the file was written); `POST`
  with malformed config is rejected with a clear error and does NOT write a
  broken file (mirroring `resolvePermissions`'s "fail loudly, never
  silently corrupt" behavior); the bearer-token gate is enforced when
  configured.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. Manual verification in a real browser against a real workspace: browse
   files, view a file's content, view/edit permissions settings and confirm
   a saved change actually takes effect on the next real session (or at
   minimum on a fresh `resolvePermissions` call) — describe this in your
   report.

## What to report back

- Files changed/added.
- Confirmation both new POST-capable routes are covered by the bearer-token
  gate (quote the tests proving it).
- Manual verification walkthrough.
- Confirmation of tsc/test/e2e results.
- Any deviation from this spec, and why.
