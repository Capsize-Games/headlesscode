# Project registry + central-store cleanup

**Audience:** implementing engineer (deepseek), working autonomously against this
repo. Read this whole document before writing code. At the end, produce a
summary + report per the "What to hand back" section — a human (not you) will
review it and either accept or send back a revision prompt.

## Problem

`~/.local/share/headlesscode/projects/<key>/` is the central per-project data
store (`src/project-store.ts`). Today it has three problems:

1. **No listing surface.** There is no `headlesscode` command and no dashboard
   endpoint that enumerates what's in the store. A human has no way to see
   what projects headlesscode knows about without hand-inspecting the
   filesystem.
2. **"Registered" is not a real concept.** `headlesscode init`'s own usage
   text calls itself "one-command project registration," but nothing in
   `project.json` actually records that a human deliberately registered a
   project. Every project dir that exists in the store — whether created by
   `headlesscode init`, by an ordinary `headlesscode run` from some cwd, or by
   a test — looks identical. There's no curated set, just "everything ever
   touched."
3. **The store is full of litter.** On the project owner's real machine,
   `~/.local/share/headlesscode/projects/` currently has **2580 directories
   totaling 1.8GB**, of which **2529 (98%) are orphaned** — their
   `project.json`'s `path` field points at a filesystem path that no longer
   exists, and **2566 (99.5%) point under `/tmp`**. Root cause: dozens of
   `*.test.ts` files under `src/**/__tests__/` create real temp workspaces via
   `fs.mkdtemp(path.join(os.tmpdir(), "hc-..."))` and then exercise engine
   code paths (permissions, mode-models, codesearch index, codemap lock,
   cost-history) that call `resolveProjectDataDir()`, which unconditionally
   `mkdirSync`s a directory and writes `project.json` into the **real** store
   unless `$HEADLESSCODE_DATA_DIR` is set. `scripts/run-tests.mjs` (the `npm
   test` entrypoint) already sets `HEADLESSCODE_DATA_DIR` as a safety net
   (line ~95), but that only helps when tests run through that wrapper — any
   direct `npx tsx src/some.test.ts` invocation (very common in this repo's
   agentic dev workflow, where subagents iterate on a single test file)
   bypasses the wrapper entirely and writes straight into the real store.

## Goals

1. Add a way to enumerate the central store: `headlesscode projects list`
   CLI command AND a `GET /api/projects` dashboard endpoint, sharing one
   underlying implementation.
2. Make "registered" a real, persisted field on `project.json`, set `true`
   only by `headlesscode init` (never by incidental contact from `run`, a
   test, or any other code path).
3. Fix the root cause of store pollution so it stops happening, without
   requiring edits to every test file that happens to `mkdtemp` a workspace.
4. Add a `headlesscode projects prune` command to reclaim already-accumulated
   litter, safely (never silently deletes a project a human registered).

## Non-goals / explicit constraints

- **Do not run `projects prune` (or any deletion) against the real
  `~/.local/share/headlesscode` on this machine.** All development and
  testing must go through `$HEADLESSCODE_DATA_DIR` pointed at a temp
  directory, exactly like the existing tests in `src/project-store.test.ts`
  do. The 2580-directory / 1.8GB cleanup on the real machine is a manual
  follow-up step the project owner will run themselves after this change is
  merged — mention it in your final report, do not attempt it.
- Do not add a new dependency, test framework, or web framework. This repo
  uses a hand-rolled CLI dispatcher (`if (argv[0] === "...")` chain in
  `src/cli.ts`), a plain `node:http` server for the dashboard
  (`src/dashboard/server.ts`), and a hand-rolled test runner (array of
  `[name, fn]` tuples executed by a bottom-of-file `main()`, discovered by
  `scripts/run-tests.mjs` globbing `**/*.test.ts`). Match these conventions
  exactly — do not introduce commander/yargs/express/vitest/jest.
- Do not touch the 60+ test files that currently `mkdtemp` without a
  `HEADLESSCODE_DATA_DIR` override. The fix in Part A below is a single
  change in `src/project-store.ts` that makes all of them safe automatically.
  Verify this claim (see Part A's test) rather than assuming it.

## Part A — stop the pollution at the source

In `src/project-store.ts`, `resolveProjectDataDir()` currently does this
unconditionally (after computing `dir` and `mkdirSync`ing it):

```ts
if (!storeOverridden()) {
	writeProjectMetadata(dir, keySource, kind)
	migrateLegacyProjectData(root, keySource, dir)
}
```

Add a second guard: skip metadata-write and legacy-migration when the
resolved `keySource` is itself under the OS temp directory (`os.tmpdir()`),
**even when `$HEADLESSCODE_DATA_DIR` is not set**. The directory still gets
created (`mkdirSync(dir, ...)` — callers still need somewhere to write
`permissions.json`/`mode-models.json`/index files during the test), it just
never gets a `project.json` stamped into it and never triggers the legacy
migration.

Rationale: grep the whole `src/` tree (excluding `*.test.ts`) for
`mkdtemp|os.tmpdir()` — production code paths (provisioning, orchestrator
worktrees, etc.) do not create real workspaces under the system temp dir; only
test files do. This makes "workspace root resolves under `os.tmpdir()`" a
reliable, low-blast-radius signal for "this is ephemeral test/scratch data,
not a real project a human is going to `init`," without requiring every test
file to opt in individually.

Implementation sketch:

```ts
function isUnderSystemTmpDir(p: string): boolean {
	const tmp = realpathOrResolve(os.tmpdir())
	const rel = path.relative(tmp, p)
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}
```

Call it in `resolveProjectDataDir` alongside the existing `storeOverridden()`
check:

```ts
if (!storeOverridden() && !isUnderSystemTmpDir(keySource)) {
	writeProjectMetadata(dir, keySource, kind, { registered: options.registered })
	migrateLegacyProjectData(root, keySource, dir)
}
```

(`options.registered` is introduced in Part B — thread it through even if you
implement Part A first.)

**Test to add** (in `src/project-store.test.ts`, following the file's
existing hand-rolled `[name, fn]` pattern): construct a workspace root
literally under `os.tmpdir()` (e.g. via `fs.mkdtempSync`), call
`resolveProjectDataDir` **without** setting `HEADLESSCODE_DATA_DIR** (you'll
need to temporarily `delete process.env.HEADLESSCODE_DATA_DIR` around the
call if the test process normally has it set — check `fs.existsSync` on
`path.join(os.homedir(), ".local", "share", "headlesscode", "projects",
projectKeyFor(<resolved keySource>), "project.json")` and assert it does
**not** exist. This test necessarily probes the real
`~/.local/share/headlesscode` path — that's the point, it's verifying the
guard — but if the guard works correctly nothing is written there. Wrap the
whole test body in `try { ... } finally { fs.rmSync(thatComputedDir, {
recursive: true, force: true }) }` so that even if the guard is broken and
the test fails, it cleans up after itself rather than adding to the litter it
exists to prevent. Restore `process.env.HEADLESSCODE_DATA_DIR` to its prior
value in the `finally` too.

Also add a **regression-guard check script** so this doesn't regress
silently: `scripts/check-tmpdir-project-store.mjs` (registered as an extra
entry in `scripts/run-tests.mjs`'s `EXTRA_FILES` array, same pattern as the
existing `scripts/check-page-script.mjs`) that greps `src/**/*.test.ts` for
files using `mkdtemp`/`os.tmpdir()` and asserts none of them ALSO reference
`HEADLESSCODE_DATA_DIR` being unset in a way that would matter — actually,
simpler and more valuable: have this script directly exercise the guard
end-to-end (call into `resolveProjectDataDir` from a child process with
`HEADLESSCODE_DATA_DIR` unset and a tmp workspace, assert no real
`project.json` appears) rather than a static grep, since the whole point of
Part A is that per-file greps are no longer load-bearing. Keep it small.

## Part B — `registered` + `lastSeen` fields on `project.json`

Current schema (written once, never updated):
```json
{ "path": "...", "kind": "git" | "plain", "firstSeen": "2026-08-16T00:16:33.310Z" }
```

New schema:
```json
{
  "path": "...",
  "kind": "git" | "plain",
  "firstSeen": "2026-08-16T00:16:33.310Z",
  "lastSeen": "2026-08-17T09:02:11.004Z",
  "registered": false
}
```

Changes to `src/project-store.ts`:

- Export a `ProjectMetadata` interface with the four fields above
  (`firstSeen`/`lastSeen` optional strings, `registered: boolean`, `path:
  string`, `kind: ProjectIdentity["kind"]`).
- Change `writeProjectMetadata` from write-once to an upsert/touch:
  - Accept a third parameter: `options: { registered?: boolean } = {}`.
  - If `project.json` doesn't exist: write a fresh object, `firstSeen =
    lastSeen = now`, `registered: options.registered === true`.
  - If it exists: best-effort parse the existing JSON (fall back to `{}` on
    parse failure, same defensive style as `loadCentralSettings`), then write
    back `{ path: keySource, kind, firstSeen: existing.firstSeen ?? now,
    lastSeen: now, registered: options.registered === true ? true :
    existing.registered === true }`. **Never downgrade `registered: true` back
    to `false`** — only `headlesscode init` sets it true, and once a human has
    registered a project it should stay registered until explicitly removed
    from the store (Part D's `prune`).
  - Keep the whole function wrapped in try/catch, non-fatal, matching the
    existing "metadata is a human-convenience, never load-bearing" comment.
- Change `resolveProjectDataDir`'s signature to `resolveProjectDataDir(workspaceRoot: string, options: { registered?: boolean } = {})` and pass `options` through to `writeProjectMetadata` as shown in Part A.
- **Caching caveat to be aware of (document, don't necessarily solve):**
  `resolveProjectDataDir` caches per resolved root in `projectDirCache` and
  returns early on a cache hit *before* ever calling `writeProjectMetadata`
  again. Within a single process this means calling it once unregistered and
  then again with `{ registered: true }` in the *same process* will NOT
  promote the flag (the second call hits the cache and returns immediately).
  This is fine for the actual call sites in this codebase (each CLI
  subcommand is a fresh process, and `headlesscode init` calls
  `resolveProjectDataDir` exactly once, as the very first thing it does) — just
  don't "fix" this by removing the cache; that cache exists so the `git`
  subprocess spawn + metadata I/O happen at most once per session, which
  matters for hot paths like `resolvePermissions()` that run on every engine
  turn.

Update `src/init/cli.ts`: change

```ts
const centralDir = resolveProjectDataDir(workspaceRoot)
```

to

```ts
const centralDir = resolveProjectDataDir(workspaceRoot, { registered: true })
```

This is the **only** call site in the whole codebase that should ever pass
`registered: true`. Grep for other `resolveProjectDataDir(` call sites
(permissions/config.ts, config/mode-models.ts, codesearch/index.ts,
codemap/lock.ts, orchestrator/cost-history.ts) and confirm you are NOT
changing any of them — they should keep calling it with no options (or
`{}`), which now also has the side effect of touching `lastSeen` on every
contact, which is desired (it's what makes "last used" meaningful in the
listing from Part C).

**Tests to add** (`src/project-store.test.ts`): a test that calls
`writeProjectMetadata` twice against the same dir with an `HEADLESSCODE_DATA_DIR`-scoped path — first without `registered`, confirm the file has
`registered: false` and note `firstSeen`; then again with `registered: true`,
confirm `registered` flips to `true` and `firstSeen` is unchanged while
`lastSeen` advances; then a third call with `registered` omitted again,
confirm `registered` stays `true` (no downgrade).

## Part C — `headlesscode projects list` + `GET /api/projects`

Add a shared listing function to `src/project-store.ts` (or a new
`src/projects/store.ts` if you prefer — your call, but keep it one function
reused by both the CLI and the dashboard, don't duplicate the directory-walk
logic):

```ts
export interface ProjectListEntry {
	key: string
	path: string | undefined     // undefined when project.json is missing/unparseable
	kind: ProjectIdentity["kind"] | undefined
	firstSeen: string | undefined
	lastSeen: string | undefined
	registered: boolean
	exists: boolean               // fs.existsSync(path) checked live, false when path is undefined
}

export function listProjectEntries(): ProjectListEntry[] {
	// Walk <projectStoreRoot()>/projects/*, read project.json when present,
	// synthesize an entry (registered:false, exists:false, path/kind/firstSeen/
	// lastSeen undefined) for dirs that have no project.json at all — those are
	// exactly the kind of pre-Part-A litter already on disk, and they should be
	// visible/prunable too, not silently skipped.
}
```

Do **not** compute directory sizes in this function by default — walking
2500+ dirs recursively for `du`-style sizes is exactly the kind of thing that
makes a `list` command slow on a polluted store, which defeats the purpose.
If you want a `--size` opt-in flag for the CLI, compute sizes lazily only for
the entries being printed, not inside `listProjectEntries` itself.

### CLI: `src/projects/cli.ts`

Follow `src/init/cli.ts`'s exact shape: a `PROJECTS_USAGE` template string, a
hand-written arg parser, an `async function projectsMain(argv):
Promise<number>`. Two subcommands:

- `headlesscode projects list [--json] [--registered-only] [--stale] [--size]`
  - Default: table of all entries (key, `reg` ✓/·, `ok`/`gone` for `exists`,
    kind, path, firstSeen, lastSeen), sorted by `lastSeen` descending (entries
    with no `lastSeen` sort last). Print a one-line summary at the end: total
    count, how many registered, how many `exists: false`.
  - `--registered-only`: filter to `registered === true`.
  - `--stale`: filter to `exists === false`.
  - `--json`: print `JSON.stringify(entries, null, 2)` instead of the table
    (no summary line — must be valid parseable JSON on stdout).
  - `--size`: include a human-readable size column (compute per-entry
    recursive byte size only for entries actually being printed, after
    filters are applied).

- `headlesscode projects prune [--dry-run] [--yes] [--include-registered]`
  - Candidates for removal, by default: entries where `exists === false &&
    registered === false`, PLUS entries with no `project.json` at all (the
    litter Part A stops producing but which already exists on disk from
    before this fix — always safe to remove, they were never a curated
    project to begin with).
  - `--include-registered`: also include `exists === false && registered ===
    true` entries in the candidate set — this is the "a registered project's
    directory is gone (deleted repo, or a temporarily unmounted drive — you
    can't tell which from here), delete its store entry anyway" escape hatch.
    Must be opt-in; never delete a registered project by default even if its
    path currently resolves as missing.
  - `--dry-run`: print what would be removed (paths + reclaimed byte count),
    remove nothing, exit 0.
  - Without `--dry-run` and without `--yes`: print the candidate list and
    byte total, then require `--yes` to actually proceed (print a message
    telling the user to re-run with `--yes`, exit 2) — no interactive
    stdin prompt (matches this CLI's non-interactive, scriptable style; every
    other subcommand here is flag-driven, not prompt-driven).
  - With `--yes`: actually `fs.rmSync(dir, { recursive: true, force: true })`
    each candidate, print what was removed and total bytes reclaimed.

Wire it into `src/cli.ts`'s dispatcher, same pattern as every other
subcommand (see `init`/`migrate`/`dashboard` around line 618-717): import
`projectsMain` near the top, add

```ts
if (argv[0] === "projects") {
	return projectsMain(argv.slice(1))
}
```

near the other subcommand checks, with a one-line doc comment above it in the
same style as the others.

### Dashboard: `GET /api/projects`

In `src/dashboard/server.ts`: add a route entry to the header-comment route
table (same format as the existing entries, e.g. right after
`/api/cost-history`), and a handler in `handleRequest` following the
`/api/summary` pattern exactly (try/catch, 200 JSON on success, 500 JSON
`{error}` on failure):

```ts
if (url.pathname === "/api/projects") {
	try {
		const all = url.searchParams.get("all") === "1"
		const entries = listProjectEntries()
		const filtered = all ? entries : entries.filter((e) => e.registered || e.exists)
		res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ projects: filtered }))
	} catch (error) {
		res
			.writeHead(500, { "content-type": "application/json; charset=utf-8" })
			.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
	}
	return
}
```

(Default view hides pure stale-unregistered litter from the dashboard;
`?all=1` shows everything, mirroring the CLI's `--registered-only`/`--stale`
split without needing identical flag names — use your judgment on the exact
filter semantics but keep it simple and document it in the route-table
comment.)

Import `listProjectEntries` from `../project-store.js` (or wherever you put
it) at the top of `server.ts`.

You do **not** need to add a UI panel to the dashboard's HTML page
(`src/dashboard/page.ts`) for this — a JSON API endpoint satisfies the goal.
If it's genuinely trivial to add a read-only "Projects" section to the
existing dashboard page given how the other sections are structured, a small
addition is welcome, but do not treat it as required; say explicitly in your
report whether you added one or not.

**Tests to add:**
- `src/projects/cli.test.ts` (or `src/projects/__tests__/cli.test.ts`,
  matching whichever convention is more common in the repo — check both
  exist as patterns and pick the more common one): build a fixture store
  under an `HEADLESSCODE_DATA_DIR`-scoped temp dir with a hand-mix of: a
  registered+existing entry, an unregistered+existing entry, a
  registered+missing-path entry, an unregistered+missing-path entry, and a
  directory with no `project.json` at all. Test `list` (table and `--json`
  modes, and each filter flag) and `prune` (dry-run changes nothing on disk;
  default `--yes` run removes only the two expected candidates and leaves the
  registered-but-missing one; `--include-registered --yes` also removes that
  one).
- Extend `src/dashboard/__tests__/server.test.ts` (or add
  `src/dashboard/__tests__/projects-routes.test.ts` following the
  `checkpoints-routes.test.ts` / `cost-history-routes.test.ts` naming
  precedent) with a test hitting `GET /api/projects` against a similarly
  seeded `HEADLESSCODE_DATA_DIR`-scoped store and asserting the JSON shape
  and default filtering.

## Part D — one-time real-machine cleanup (do NOT do this yourself)

Once this ships, the project owner will run, on their own machine:

```
headlesscode projects list --stale --json | jq length   # sanity check the count
headlesscode projects prune --dry-run
headlesscode projects prune --yes
```

to reclaim the ~1.8GB / ~2500 orphaned directories currently in
`~/.local/share/headlesscode/projects/`. **You must not run `projects prune`
(with or without `--dry-run`) against the real, unoverridden store as part of
implementing or testing this feature.** Every test you write or run yourself
must set `HEADLESSCODE_DATA_DIR` to a throwaway temp directory first, exactly
like `src/project-store.test.ts` already does. Mention this manual follow-up
step in your final report so the project owner remembers to run it.

## Definition of done

- [ ] `resolveProjectDataDir` skips real-store metadata writes for workspace
      roots under `os.tmpdir()`, verified by a test that (safely, with
      cleanup) checks the real store path is untouched.
- [ ] `project.json` has `lastSeen` (updated on every contact) and
      `registered` (upserted, only ever set `true` by `headlesscode init`,
      never downgraded).
- [ ] `headlesscode init` passes `{ registered: true }`; no other call site
      does.
- [ ] `headlesscode projects list` and `headlesscode projects prune` exist,
      wired into `src/cli.ts`'s dispatcher, with `--help` text following the
      existing usage-string convention.
- [ ] `GET /api/projects` exists on the dashboard server, documented in the
      file's route-table header comment.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes in full (this is the whole existing suite, not just
      new tests — it must still pass, and per Part A it should no longer
      write into the real store when run file-by-file either).
- [ ] No test, script, or manual step in your own work touched the real
      `~/.local/share/headlesscode` destructively.

## What to hand back

When done, write a summary covering:
1. What you changed, file by file (short bullet list, not a diff dump).
2. Confirmation `npm run typecheck` and `npm test` both pass (paste the tail
   of the output).
3. Explicit confirmation that no destructive command was run against the
   real `~/.local/share/headlesscode` store during your work.
4. Any deviation from this spec and why (e.g. if you put
   `listProjectEntries` somewhere other than `project-store.ts`, or changed a
   flag name) — call these out explicitly, don't bury them.
5. Remind the project owner about the Part D manual cleanup step.

This will be reviewed against the code itself, not just your summary — make
sure the summary is accurate.
