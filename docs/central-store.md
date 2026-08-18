# Central project store & its protection

## What and where

`headlesscode` keeps all per-project, cross-session state (codebase-search
index, `mode-models.json`, `permissions.json`, project metadata), plus
checkpoints and the shared modes/rules, under ONE central directory:

```
~/.local/share/headlesscode/        (XDG data-dir convention)
  projects/<project-key>/           per-repo state (key derived from the repo's
                                    git-common-dir parent, so worktrees share it)
  checkpoints/                      shadow-git checkpoint store
  shared/                           modes.yaml + rules(-<mode>)/
  settings.json                     cross-project operational defaults
```

`$HEADLESSCODE_DATA_DIR` overrides the root (tests and scratch setups redirect
it; see `src/project-store.ts:58`). All of the path resolution lives in
`src/project-store.ts` — the protection described below reuses that resolver
rather than duplicating it.

## Default-on protection against destructive commands

The command allow/deny system (`src/permissions/`) is deliberately opt-in:
with no `permissions.json`, an EMPTY allow-list means "allow everything except
the deny-list". That is fine for general command policy, but the central store
is a different resource — it is SHARED across every project on the machine, so
a single misbehaving workspace deleting it has a blast radius far beyond that
workspace. This happened for real: a worker ran
`rm -rf ~/.local/share/headlesscode` against the live store three times as an
ad-hoc verification step.

The protection (`src/permissions/store-protection.ts`, wired into
`checkCommand` in `src/permissions/commands.ts`) therefore:

- **Is always on** — it runs even with zero permissions configuration, ahead
  of and independent of the allow/deny lists. The empty-allow-list
  default-ALLOW branch cannot bypass it.
- **Is not overridable** by a per-workspace `.headlesscode/permissions.json`
  or `--allowed-commands` — a config file a worker could write must never
  authorize deleting the shared store. (No override mechanism exists today; if
  a legitimate one is ever needed it must be a deliberate, harder-to-reach
  human action, not a worker-writable file.)
- **Only gates the `execute_command` TOOL.** The harness's own code paths —
  `headlesscode migrate`, index writes, project-metadata writes — never pass
  through `checkCommand` and are completely unaffected.
- **Is pattern-based, not a sandbox.** It catches recursive `rm` invocations
  (`rm -rf`, `rm -r`, `rm -fr`, `-R`, `--recursive`, any flag order) whose
  RESOLVED target is the store root or a parent of it. Resolution handles `~`,
  `$VAR`/`${VAR}`, quoting, relative paths (anchored on the command's working
  directory), and a trailing `/*` glob. It deliberately does NOT claim
  completeness: a wrapper script, `python -c "shutil.rmtree(...)"`,
  `find ... -delete`, a non-recursive `rm` of a single file inside the store,
  or a descendant target (`rm -rf <store>/projects`) are out of v1 scope. This
  is a speed bump against the exact class of mistake that already happened,
  not a proof of safety.

## Production / multi-tenant picture

The docker provider (`src/cloud/docker-provider.ts`) mounts only two paths
into a session container: the target repo at `/workspace` (read-write) and the
harness checkout at `/harness:ro`. The host's `~/.local/share/headlesscode`
is NOT mounted. Two consequences:

1. **The incident is structurally impossible in the docker path.** A container
   has no filesystem path to the host's shared store to destroy in the first
   place. The real production containment already exists for what is mounted;
   the gap this plan fixes is specifically local/direct-execution mode (what
   every session used the night of the incident).
2. **The central-store feature does not function for docker-based sessions at
   all today** — there is no shared mount for them to read from or write to.
   This is a real, separate, unresolved design question: adding a shared mount
   reintroduces the same cross-tenant blast-radius risk the protection above
   addresses, while leaving it out means the feature simply does not work in
   containers. This is deliberately NOT solved here — flag it as future work
   before any multi-tenant central-store rollout.
