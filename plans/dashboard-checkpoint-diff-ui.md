# Dashboard: browser checkpoint list/diff/restore UI — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop.
Checkpoints (shadow-git snapshots per session, `src/checkpoints/service.ts`)
already work and are fully usable via CLI (`headlesscode checkpoints
--workspace <path> [list | restore <hash> | diff <hash>]`) — this task adds
the same capability to the browser dashboard, which currently has none.

Match this project's established style: ZERO new UI/framework dependencies
(plain HTML/CSS/vanilla JS, no build step — see `src/dashboard/page.ts`'s
own header comment); no test framework (plain `tsx`-run test files); `npx
tsc --noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh`.

## Note on concurrent work

`plans/dashboard-chat-ui.md` and
`plans/dashboard-file-browser-and-permissions-ui.md` may be running at the
same time — all three touch `src/dashboard/page.ts` and possibly
`server.ts`. Real conflict risk. If you hit one, re-read the other tasks'
actually-merged final state before resolving, and prefer additive changes
over restructuring shared code.

## What already exists (read before building)

`src/checkpoints/service.ts`'s `CheckpointService` class:
`list()` (oldest-first, message + date), `diff({from?, to?})` (diff between
two checkpoints, or a checkpoint vs. current working tree when `to` is
omitted), `restore(commitHash)` (reverts real files). This is the exact
logic to call — do not reimplement shadow-git diffing/restoring, wrap the
existing service.

**Restore is destructive** — it reverts real workspace files. Read
`createCheckpointService`'s own doc comment about `checkpointDir` safety
requirements (must be outside `workspaceRoot`) before touching anything
here, and treat restore as the single most dangerous action this dashboard
can perform — more dangerous than `session/start` (which only launches new,
reviewable work) or pause/resume (which only affects timing).

## What to build

### 1. New dashboard API routes (`src/dashboard/server.ts`, following the
existing route-table pattern in that file's header comment)

- `GET /api/checkpoints?repo=<path>&session=<taskId>` — list checkpoints for
  a session (wraps `CheckpointService.list()`).
- `GET /api/checkpoints/diff?repo=<path>&session=<taskId>&from=<hash>&to=<hash?>` —
  diff between two checkpoints, or a checkpoint vs. current working tree.
- `POST /api/checkpoints/restore?repo=<path>&session=<taskId>` with a JSON
  body `{hash}` — performs the actual restore.

**Restore MUST go through the same optional bearer-token gate** already
established for `/api/session/*` POST routes (`options.token`,
`HEADLESSCODE_DASHBOARD_TOKEN` — check the exact gating logic near the top
of `handleRequest` in `server.ts` and extend its path-matching to cover
this new route, don't build a parallel auth mechanism). Given restore is
MORE dangerous than the routes that gate already covers, do not ship it
ungated relative to those.

### 2. Dashboard UI (`src/dashboard/page.ts`)

- A checkpoints panel in the session detail view: list of checkpoints
  (message, date, hash) for the session being viewed.
- Clicking a checkpoint shows its diff (call the diff route, render as a
  simple unified-diff-style text block — no need for a fancy side-by-side
  view or syntax highlighting, this project's dashboard is deliberately
  plain; check if there's any existing diff-rendering precedent anywhere in
  this codebase, e.g. in review-mode tooling, before inventing a format).
- Restore requires an explicit confirmation step in the UI (a real "are you
  sure" — this reverts real files) before the POST fires. Do not make
  restore a single accidental click away.
- After a restore, the checkpoints list / diff view should refresh to
  reflect the new state (don't leave stale-looking data after a destructive
  action).

## What NOT to do

- Do not add a UI framework, syntax-highlighting library, or diff-rendering
  library — plain text diff output is fine, matches this project's ethos.
- Do not weaken or bypass the existing bearer-token gate for the new
  restore route.
- Do not change `CheckpointService`'s own logic — this task is a UI/API
  wrapper around what already exists and is tested.
- Do not allow restore without an explicit confirmation step.

## Tests

- `src/dashboard/__tests__/checkpoints-routes.test.ts` (or extend the
  existing server test file — check current structure first): list/diff/
  restore routes against a real `CheckpointService` backed by a temp git
  repo (mirror how `src/checkpoints/__tests__/service.test.ts` sets up its
  fixtures), covering success cases and the "restore requires a bearer
  token when configured" case.
- A test proving restore actually reverts a file (create checkpoint, modify
  file, restore, assert file content is back to the checkpointed version) —
  through the HTTP route, not just the underlying service (which is already
  tested elsewhere).

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. Manual verification: start the dashboard against a real workspace with
   real checkpoints, actually click through list -> diff -> restore in a
   real browser, confirm the file really reverts and the UI reflects it.
   Describe this in your report (screenshot or detailed walkthrough) since
   it's a visual + destructive-action feature automated tests can't fully
   cover.

## What to report back

- Files changed/added.
- Confirmation the auth gate covers the new restore route (quote the test
  proving it).
- Manual verification walkthrough/screenshot.
- Confirmation of tsc/test/e2e results.
- Any deviation from this spec, and why.
