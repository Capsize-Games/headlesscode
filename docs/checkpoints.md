# Checkpoints — shadow-git undo layer

Checkpoints port Zoo Code's auto-commit undo mechanism into the headless
harness. Every edit-capable session snapshots the workspace into a hidden
**shadow git repository** — separate from any real git repo the workspace
happens to have — so a bad edit (or a whole bad run) can be reverted without
touching the user's own commits, branches, or index.

## Mechanism

A "checkpoint" is a commit in a shadow git repo whose `core.worktree` points
at the real workspace. Two things fall out of that:

- **It never interferes with the target repo's own git state.** The shadow
  repo has its own `.git`, its own commits, its own branch — the target
  repo's `git status`/`git log`/`git add` are completely unaffected.
- **Restoring a checkpoint actually reverts real files.** `restore` runs
  `git reset --hard <hash>` + `git clean -f -d -f` against the shadow repo,
  which — because `core.worktree` is the real workspace — checks that
  commit's file contents out onto the real files.

This is the same mechanism Zoo Code uses in VS Code
(`RepoPerTaskCheckpointService` / `ShadowCheckpointService`, vendored at
`src/vendor/zoo-code/src/services/checkpoints/`), adapted for a
non-interactive process (no toast notifications, no webview).

### Storage location — outside the workspace, always

The shadow repo for a session lives at
`<checkpointDir>/tasks/<taskId>/checkpoints`, where `checkpointDir` defaults
to the central data store's **`~/.local/share/headlesscode/checkpoints`**
(see `src/project-store.ts`; the old `~/.headlesscode/checkpoints` is
migrated there once on first use, and `headlesscode migrate` runs the same
migration explicitly) — **not** inside the workspace being tracked, and this
is enforced: `createCheckpointService` throws if `checkpointDir` resolves
inside `workspaceRoot`.

This is a deliberate deviation from a workspace-local
`<workspaceRoot>/.headlesscode/checkpoints` default. Two of the vendored
git operations only work correctly when the shadow dir is outside the
worktree they track (this mirrors how Zoo Code itself always stores shadow
repos outside any workspace, under VS Code's `globalStorageUri`):

- `stageAll()` (used by init/save/diff) runs `git add` with `cwd` set to the
  shadow dir itself. If the shadow dir is nested inside the workspace, the
  `.` pathspec resolves relative to that nested `cwd` — so it only ever
  matches the shadow dir's own (nearly empty) contents, never the rest of
  the workspace, and every checkpoint silently becomes an empty commit. This
  harness patches `stageAll` to use `git add -A` (which resolves against the
  repo root regardless of `cwd`) as defense in depth, but that alone doesn't
  make nesting safe — see the next point.
- `restore()` runs `git clean -f -d -f` against the workspace. If the shadow
  dir is nested inside the workspace, git considers the shadow dir untracked
  clutter (a git repo doesn't track its own `.git`) and **deletes it,
  including its own `.git` directory** — destroying the checkpoint history
  mid-restore.

Because the default checkpoint dir is global (under the user's home
directory) rather than per-target-repo, there is nothing to add to a target
repo's `.gitignore` — unlike `.worktrees/` (see `docs/phase2-orchestration.md`),
checkpoint storage never lives inside a repo you're working on. Each
session's shadow repo is namespaced by a random session id, so unrelated
workspaces/sessions never collide.

Override the location with `--checkpoint-dir <path>` (must also be outside
the workspace) if you want checkpoints somewhere other than the default —
e.g. a shared cache volume in a container.

## When checkpoints run

Checkpoints are **on by default** for a normal (edit-capable) session:

- A **baseline checkpoint** is saved before iteration 1 (mirrors Zoo Code's
  `Task.ts` behavior at session start).
- A checkpoint is saved **after every loop iteration that executed at least
  one tool call** (mirrors Zoo Code's per-turn `checkpointSave(true)` in
  `presentAssistantMessage.ts` — granularity is per-turn, not per-file-write).

Checkpoints are **skipped entirely** for read-only sessions (the reviewer and
QA modes use executors with no `write_to_file` registered — there's nothing
to checkpoint) and can be disabled explicitly with `--no-checkpoints`.

Checkpoint failures are always **non-fatal**: any error (git not installed, a
nested git repo detected in the workspace, a save/restore failure) is logged
as a warning and disables checkpoints for the rest of that session — it never
fails the run.

## CLI usage

```
headlesscode checkpoints --workspace <path> list
headlesscode checkpoints --workspace <path> restore <hash>
headlesscode checkpoints --workspace <path> diff [<from-hash>] [<to-hash>]
```

Since each session gets its own random session id, a workspace can have
checkpoint history from multiple past runs. The CLI auto-detects the most
recently active session for `--workspace` (by scanning shadow repos under
`--checkpoint-dir`/the default for one whose `core.worktree` matches and
picking the newest); pass `--task-id <id>` to target a specific session.

```
headlesscode checkpoints --workspace ~/code/myrepo list
  a1b2c3d4e5f6  2026-07-31T10:00:00-06:00  Task: <id>, Time: 1753...
  ...

headlesscode checkpoints --workspace ~/code/myrepo restore a1b2c3d4e5f6
  Restored workspace to checkpoint a1b2c3d4e5f6
```

`restore` is destructive: any uncommitted changes made since that checkpoint
are lost (the shadow repo does a hard reset + clean). There is no "undo the
restore" beyond restoring to a later checkpoint if one exists.

## Session flags

| Flag | Effect |
| --- | --- |
| `--no-checkpoints` | Disable checkpoints for this session (edit-capable sessions only; read-only sessions never checkpoint regardless) |
| `--checkpoint-dir <path>` | Override the shadow-git storage root (default `~/.local/share/headlesscode/checkpoints`; must be outside the workspace) |

## Programmatic use

```ts
import { createCheckpointService } from "./src/checkpoints/service.js"

const service = createCheckpointService({ taskId: "my-task", workspaceRoot: "/path/to/repo" })
await service.init()
await service.save("before risky refactor")
// ... edits happen ...
await service.restore(hash) // reverts real files
const entries = await service.list() // oldest-first: { hash, date, message }
const changes = await service.diff({ from: hash }) // per-file before/after content
```

`service.ts` does not swallow errors — callers are expected to wrap calls in
try/catch and treat failures as non-fatal, exactly like `HeadlessSession`
does internally (see `src/engine/loop.ts`).
