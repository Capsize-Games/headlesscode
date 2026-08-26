# Deterministic per-project codemap

The codemap is a script-generated, machine-readable map of a project's
modules and their import/include relationships, the cross-module function
calls (TypeScript/JS), and entrypoint-rooted end-to-end flows — plus a
self-contained interactive HTML visualizer. It exists so a headlesscode worker
that needs to know "what is this repo, what imports what, what calls what,
where do the entrypoints lead" can read `codemap.json` instead of re-deriving
structure via grep every session. **No LLM is involved anywhere in the
pipeline** (issues #17/#18's hard requirement): the map is fully
deterministic, fast to regenerate, and cheap to keep fresh with a watcher.

## What gets generated

For a workspace, `headlesscode codemap --workspace <path>` writes three files
into the **central per-project data store** (same resolution as the
codebase-search index — worktrees of a repo share one codemap):

```
~/.local/share/headlesscode/projects/<project-key>/codemap/
  codemap.json   machine-readable module/edge graph (served by the dashboard)
  codemap.lock   per-module content fingerprints (change detection)
  codemap.html   self-contained interactive visualizer (open in a browser)
```

- `codemap.json` — every module (path, language, size/line counts, a
  naming-convention **role**: source/test/entrypoint/config/vendor/generated),
  every **edge** between workspace modules (`import`/`include` for all
  languages, plus `call` edges for TS/JS — see below), per-module **external
  deps** (specifiers that resolve outside the workspace — e.g. `node:fs`,
  third-party libs), entrypoint-rooted **flows**, and a deterministic content
  **fingerprint**.
- `codemap.lock` — a sha256 per module path. The next build compares the
  current inventory against it: identical key set + hashes ⇒ **no writes at
  all**. Any edit/new/deleted file ⇒ a full regeneration (fast — full regen is
  the deliberate v1 choice; per-module incremental regen isn't worth the
  complexity when a whole repo regenerates in seconds).
- `codemap.html` — a single self-contained HTML file (inline CSS + vanilla JS,
  no CDN, no server needed). Dark theme, layered by dependency depth,
  zoom/pan, search/filter, and click-a-node to highlight its
  imports/importers with a detail panel.

## How to run

```bash
# One-shot (what a cron/systemd timer should invoke)
npx tsx src/cli.ts codemap --workspace /path/to/project

# Force regeneration even if the lock says nothing changed
npx tsx src/cli.ts codemap --workspace /path/to/project --force

# Long-running poll loop: regenerate on change, sleep, repeat
npx tsx src/cli.ts codemap --workspace /path/to/project --watch

# Or via the wrapper script (same thing; friendly for cron/systemd)
scripts/codemap-watch.sh /path/to/project                 # watch mode
scripts/codemap-watch.sh --once /path/to/project          # one-shot
scripts/codemap-watch.sh --interval-ms 300000 /path/to/project
```

The CLI prints where the files landed and whether it wrote anything:

```
codemap: regenerated 316 modules, 648 edges (fp 748530e6b7f3)
  /home/user/.local/share/headlesscode/projects/d204ffca5cc53e79/codemap/codemap.json
  /home/user/.local/share/headlesscode/projects/d204ffca5cc53e79/codemap/codemap.html

codemap: unchanged — no writes (316 modules, 648 edges cached, fp 748530e6b7f3)
```

## Dashboard

The dashboard (already bound to `127.0.0.1`, `headlesscode dashboard`) serves
whatever codemap exists for a repo, reusing the established `?repo=<path>`
convention:

- `GET /api/codemap?repo=<path>` — the stored `codemap.json`
- `GET /api/codemap/html?repo=<path>` — the visualizer (opens standalone)

A repo with no generated map gets a 404 that says exactly how to build one.
The dashboard never generates on request — generation is a script job.

## Per-language extraction

Everything is mechanical and deterministic:

| Language | Extractor |
| --- | --- |
| TypeScript / JS | `getImportGraph()` from `src/codeintel/import-graph.ts` (import edges) and `getCallGraph()` from `src/codeintel/call-graph.ts` (Phase 2 call edges) — both built on the real TS Language Service/checker, so tsconfig `paths` aliases and call targets resolve exactly as the compiler would (overloads, re-exports, method calls all land on the real declaration). Modules the TS program doesn't cover (e.g. standalone `.mjs` scripts outside `tsconfig` include) simply carry no import/call edges. |
| Python | `scripts/codemap-python-extract.py` — a stdlib-`ast` subprocess (the project's established pattern for Python tooling) resolving `import` / `from ... import` / relative imports to module files, best-effort. Call edges stay Phase 2+ for Python (see below). |
| C / C++ | regex `#include` graph (good enough for structure; symbol-level resolution needs a compiler frontend and stays out of scope unless a concrete need appears). |

Edges that resolve **outside** the workspace (node_modules, builtins, failures)
never become graph nodes — they're summarized per module in
`externalDeps`, keeping the map a map of *this* project.

## Phase 2: call edges + entrypoint flows (issue #18)

Phase 1 was import/include-only. Phase 2 adds the tractable core of the
original "calls/reads/writes/publishes/subscribes + ranked flows" prompt,
with the same **no LLM** requirement:

- **`call` edges (TS/JS only).** For every call/constructor site, the TS
  checker's resolved signature gives the callee's real declaration, whose
  file is the edge target. One edge per module pair (callee names are joined
  into `specifier`), so the module graph stays clean. Self-calls and calls
  into node_modules/lib are dropped — external call targets are already
  visible through the module's import edges.
- **Entrypoint flows.** `codemap.json` gains a `flows` map: for each
  `entrypoint` module, the sorted list of every module reachable from it
  along directed import+call edges (`src/codemap/flows.ts`). Deterministic
  and derived (not fingerprinted — a pure function of modules + edges).

**Deliberate non-goals, per the issue's own analysis:**
- **Ranking flows by "importance"** was considered and punted: every
  heuristic either needs per-framework semantics (FastAPI routes, Celery
  tasks, pub/sub topics) that require project-specific pattern lists, or
  reduces to sorting by reachable-set size. Wrong ranking is worse than no
  ranking ("Mark any relationship without source evidence as unknown"), so
  the map surfaces the flows and lets a human/worker filter.
- **Python call edges** need the framework pattern lists (FastAPI `@app.get`
  → HTTP entrypoint, Celery `@app.task` → queue consumer, …). Those are
  inherently project-specific and will be scoped to a concrete project when
  someone needs them — not built speculatively generic.
- **C++ call edges** need a real compiler frontend (clang libtooling /
  `-ast-dump`), a much bigger investment than this project currently
  justifies. Includes-only stays.

## Keeping it fresh (watcher install)

Two idiomatic options:

**Long-running poll loop** — `scripts/codemap-watch.sh <path>` runs
`headlesscode codemap --watch` (regenerate-on-change, sleep, repeat). Cleanly
stops on SIGINT/SIGTERM. Fine as a systemd *service* or a session-manager
autostart for a machine you work on constantly:

```
# /etc/systemd/system/codemap-watch.service
[Unit]
Description=headlesscode codemap watcher (project X)
After=network.target

[Service]
Type=simple
ExecStart=/home/user/headlesscode/scripts/codemap-watch.sh --interval-ms 120000 /home/user/Projects/project-x
Restart=on-failure

[Install]
WantedBy=default.target
```

**Systemd timer / cron** — timers already handle "every N minutes", so the
timer should invoke the cheap **one-shot** form:

```
# /etc/systemd/system/codemap.timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=15min

# /etc/systemd/system/codemap.service
[Service]
Type=oneshot
ExecStart=/home/user/headlesscode/scripts/codemap-watch.sh --once /home/user/Projects/project-x
```

A one-shot against an unchanged repo does nothing but re-hash the inventory —
milliseconds — so an aggressive schedule is fine.

## Scope / limits

- The graph has `import`/`include` edges for every language and `call` edges
  for TS/JS. `reads`/`writes`/`publishes`/`subscribes` edges and *ranked*
  flows are not built (see "Phase 2" above for the per-language reasoning).
- C++ includes are regex-resolved, not symbol-resolved.
- Roles are naming-convention heuristics (deterministic, but a file named
  `main.py` deep in a package is tagged "entrypoint" by convention, not
  semantics).

## Implementation notes

- `src/codemap/` — types, inventory+roles (`files.ts`), fingerprinting
  (`fingerprint.ts`), central-store paths + lock (`lock.ts`), per-language
  extraction (`extract.ts`), the HTML generator (`html.ts`), the build
  pipeline (`build.ts`), and the CLI (`cli.ts`).
- The dashboard read-side lives in `src/dashboard/codemap.ts` with routes in
  `src/dashboard/server.ts`.
- Tests: `src/codemap/__tests__/build.test.ts` (fixtures for all three
  languages + fingerprint-aware regeneration) and
  `src/dashboard/__tests__/codemap-routes.test.ts`.
