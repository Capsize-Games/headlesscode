# Protect the shared central store from destructive commands (HIGH PRIORITY)

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository —
a standalone Node/TypeScript CLI running a headless coding-agent loop. Match
the project's established conventions: no test framework beyond hand-rolled
`assert` + `tsx`-run test files, minimal new dependencies, `npx tsc --noEmit`
and `npm test` must stay green, re-run `scripts/e2e*/run.sh` afterward.
**Commit your work incrementally per logical change before calling
`attempt_completion`.**

**This is prioritized AHEAD of `plans/live-message-injection-for-chat-uis.md`
— dispatch this one first**, once `plans/central-project-store-and-shared-
instructions.md` is fully merged. This is a real, already-demonstrated
data-loss safety gap, not a feature request.

**When testing this yourself: NEVER run destructive commands against the
real `~/.local/share/headlesscode` path. Use `HEADLESSCODE_DATA_DIR`
pointed at a throwaway tmp directory for every test, always. This exact
mistake is what motivated this plan — see below.**

## The incident (real, happened tonight, more than once)

While implementing the central project data store
(`plans/central-project-store-and-shared-instructions.md`), the worker ran
`rm -rf ~/.local/share/headlesscode` as an ad-hoc manual verification step
— **at least three separate times**, confirmed directly in `harness.log`.
This is the real, shared, cross-project central store the same plan just
built — not a disposable test fixture. It destroyed real data: headlesscode's
own codesearch index (cheap, ~$0.18 to rebuild — no lasting harm) and came
within one command of destroying airunner's much more expensive ~900MB
index (it happened to survive only because that particular `rm -rf` call
didn't target it directly, not because anything prevented it).

Root cause, confirmed by reading the code: `src/permissions/commands.ts`'s
`checkSingleCommand` — "EMPTY allow-list = default-ALLOW... only the
deny-list applies... preserves today's behavior for sessions that configure
nothing." With no `.headlesscode/permissions.json` (true for every worktree
tonight, and true for any project that hasn't explicitly opted in), there is
NO default protection against a destructive command targeting a path
outside the current workspace — `execute_command` can run anything,
including `rm -rf` against an arbitrary absolute path.

## What to build

### 1. A default-on protection, not an opt-in one

The existing permissions system (`src/permissions/`) is deliberately
opt-in — that's fine for general command policy, a legitimate operator
choice. But the central store (`src/project-store.ts`'s resolved data
directory) is a NEW, categorically different resource: it's SHARED across
every project on the machine (and, once
`plans/live-message-injection-for-chat-uis.md`-style multi-session use
becomes common, potentially across concurrent sessions too). A single
misbehaving workspace destroying it has a blast radius far beyond that
one workspace — this must be protected by DEFAULT, with no configuration
required, not left to an operator remembering to opt in.

Add a check in `src/permissions/commands.ts` (or a new sibling module if
that fits better — check the existing structure before deciding) that:
- Detects destructive filesystem commands: `rm -rf`, `rm -r`, `rm -fr`, and
  similar recursive-delete invocations. Be honest about scope: this is
  PATTERN-BASED detection, not a hermetic sandbox — it cannot catch every
  conceivable way to destroy a file (a script that does it indirectly, a
  `python -c "shutil.rmtree(...)"`, etc.). Document this limitation
  explicitly rather than implying false completeness. It's a speed bump
  against the exact class of mistake that already happened, not a proof of
  safety.
- Resolves the command's target path(s) (handling `~` expansion, env var
  expansion like `$HOME`, relative-vs-absolute) and checks whether the
  resolved path is THE central store root (reuse `project-store.ts`'s own
  path-resolution function — don't hardcode a second copy of that path
  logic) or a parent of it.
- Refuses by default when a destructive command's target matches — this
  check runs even with an EMPTY `deniedCommands` list (i.e., it's not
  something `checkSingleCommand`'s existing empty-allowlist-default-allow
  branch should bypass; wire it in as an always-applied check ahead of or
  alongside the existing allow/deny logic, not gated by whether permissions
  are configured at all).
- This protection should NOT be overridable by a per-workspace
  `.headlesscode/permissions.json` — a single workspace's own config file
  authorizing destruction of the SHARED resource defeats the purpose (the
  whole point is protecting it FROM any one workspace, including a
  misconfigured or compromised one). If a legitimate override is ever
  needed, it should be a separate, explicit, harder-to-reach mechanism
  (e.g. an env var a human sets deliberately for the one session that
  needs it, never a file a worker itself could write) — don't build that
  override mechanism speculatively now; only add it if a real need shows
  up.

### 2. Legitimate access stays legitimate

The `headlesscode migrate` subcommand (from the central-store plan) and
the CLI's normal read/write access to the central store during real
operation (looking up a project's index, writing a fresh one, etc.) must
continue working unaffected — this check is specifically about
DESTRUCTIVE commands run via the `execute_command` TOOL (a worker's own ad
hoc shell commands), not about the harness's own internal code paths that
legitimately manage the store. Verify this distinction is actually
respected: the new check lives in the command-permission gate that
`execute_command` goes through, not in `project-store.ts` itself.

### 3. Document the production/multi-tenant picture honestly (don't build anything here — just write it down)

Confirmed by reading `src/cloud/docker-provider.ts`: only `/workspace`
(the target repo) and `/harness:ro` are mounted into a session's
container — the host's `~/.local/share/headlesscode` is not mounted at
all today. Two consequences, both worth a short note in
`docs/` (wherever central-store's own doc ends up, or a new short doc):
- Today's exact incident is structurally impossible in the docker/
  multi-tenant path — a container has no filesystem path to the host's
  shared store to destroy in the first place. The real production
  containment already exists for what's mounted; the gap this plan fixes
  is specifically in local/direct-execution mode (what every session
  tonight used).
- BUT this also means the central-store feature (shared index/config
  across projects) currently does NOT function for docker-based sessions
  at all — there's no shared mount for them to read from or write to.
  This is a real, separate, unresolved design question (shared mount =
  reintroduces the same cross-tenant blast-radius risk this plan is
  fixing; no shared mount = the feature just doesn't work there) — flag it
  explicitly as future work, do not attempt to solve it as part of this
  plan. Scope creep here would delay the urgent local-mode fix for a much
  harder multi-tenant design problem.

## What NOT to build

- Don't build a general filesystem sandbox/jail for `execute_command` in
  local/direct-execution mode. That's what the docker provider already is
  for production use — duplicating real OS-level containment in local mode
  is a much bigger effort than this specific, targeted fix warrants. This
  plan is a pattern-based guard against the specific class of mistake that
  already happened, not a comprehensive security boundary.
- Don't try to enumerate and block every possible destructive command
  pattern (there's no complete list). Scope the first version to `rm -rf`/
  `rm -r`/`rm -fr` — the exact commands that caused tonight's incident —
  and note in the code that this is deliberately narrow, not exhaustive.
- Don't solve the multi-tenant/docker central-store mounting question here
  (see above) — write it down, don't design it in this round.

## Testing

- A regression test proving `rm -rf ~/.local/share/headlesscode` (and
  common variants: `rm -rf ~/.local/share/headlesscode/`, `rm -fr`, with
  `~` and `$HOME` both expanding to the same real path) is refused by
  `checkCommand`/`decideCommand` with ZERO permissions configuration —
  the exact scenario that failed tonight. This is the single most
  important test in this whole plan; get it right before anything else.
- A test proving a destructive command against a path INSIDE the current
  workspace (e.g. `rm -rf ./tmp-scratch`) is NOT blocked by this new
  check — only paths resolving to the central store (or its parents) are
  refused, not ordinary workspace cleanup.
- A test proving this check cannot be bypassed via a workspace-level
  `.headlesscode/permissions.json` entry (confirm the "not overridable by
  per-workspace config" design point actually holds in code, not just in
  the plan doc's prose).
- A test proving legitimate central-store access (e.g. a fake/stubbed
  `headlesscode migrate` invocation, or `project-store.ts`'s own internal
  read/write calls) is completely unaffected — this check only gates the
  `execute_command` tool path, nothing else.
