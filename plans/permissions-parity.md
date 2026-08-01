# Command allow/deny + protected-file parity — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI that runs a headless coding-agent loop (ported
from a VS Code extension called Zoo Code, vendored under `src/vendor/zoo-code/`).
The full original source is also available for reference (read-only, do not
edit) at `zoo-code/` in this repo — a complete clone of the upstream project.

Match this project's established style:

- No test framework — plain `tsx`-run test files, hand-rolled assertions,
  `All N tests passed` trailer (see `src/tools/__tests__/*.test.ts` for the
  pattern). Add new test files to `package.json`'s `test` script the same
  way existing entries are chained with `&&`.
- `npx tsc --noEmit` and `npm test` (currently 22 suites) must stay green.
  Re-run all five e2e suites under `scripts/e2e*/run.sh` afterward.
- No settings UI exists or will exist here (that's a VS Code-only concept) —
  everything in this task is CLI flags / env vars / a config file, not a
  panel.

## The problem

In the original VS Code extension, a real settings-backed enforcement layer
sits in front of every command execution and file write:
`zoo-code/src/core/auto-approval/index.ts` (the decision logic),
`zoo-code/src/core/auto-approval/commands.ts` (command allow/deny matching,
including `parseCommand` for splitting compound shell commands on
`&&`/`;`/`|`/etc. so each sub-command is checked independently, and
`containsDangerousSubstitution` — a set of regex checks that catch shell
parameter-expansion tricks like `${var@P}` or `<<<$(...)` that can smuggle
command execution past a naive allow-list match; read that file, it's short
and well-commented). The settings schema lives in
`zoo-code/packages/types/src/global-settings.ts` — relevant fields:
`allowedCommands`, `deniedCommands`, `alwaysAllowWriteProtected`, plus the
various `alwaysAllow*` toggles.

`headlesscode`'s executor (`src/tools/executor.ts`) has **none of this**.
`execute_command` runs anything the model asks with no allow/deny check at
all. `write_to_file` has only a path-traversal guard (can't write outside the
workspace root) — nothing protects specific files (e.g. `.env`, credentials,
CI config) from being silently overwritten by the model.

This matters more here than it did in the interactive version: in the
VS Code extension, a human still has to click "approve" even with
auto-approval settings configured a certain way, and there is always a human
present to notice something wrong. In `headlesscode`, workers run completely
unattended, spawned by an orchestrator that is itself meant to run without a
human watching in real time. There is currently zero enforcement standing
between "the model decided to do something" and "it happened."

## What to build

### 1. Config surface

Since there's no settings UI, this is CLI flags + env vars, following the
exact pattern already established for other per-session config in
`src/cli.ts` (e.g. `--max-cost-usd`/`HEADLESSCODE_MAX_COST_USD` — read that
for the flag/env-fallback wiring convention and mirror it exactly):

- `--allowed-commands <comma-separated-list>` / `HEADLESSCODE_ALLOWED_COMMANDS`
- `--denied-commands <comma-separated-list>` / `HEADLESSCODE_DENIED_COMMANDS`
- `--protected-files <comma-separated-glob-list>` / `HEADLESSCODE_PROTECTED_FILES`
  — default this to a sane built-in list even when unset: `.env`, `.env.*`,
  `*.pem`, `*.key`, `id_rsa*` (adjust/extend sensibly, but ship a real
  default rather than leaving this off by default — unlike command
  allow/deny, which is reasonable to default to "everything allowed" for
  backward compatibility, silently-writable secret files is not a safe
  default for an unattended agent).
- Also support a JSON config file for these three (mirror how
  `HEADLESSCODE_PRICING_JSON` is loaded as a file override in
  `src/budget/cost.ts` — same idea, same style) so a target repo can commit
  its own policy rather than relying on env vars per invocation. Sensible
  location: `<workspaceRoot>/.headlesscode/permissions.json` if present,
  loaded automatically without needing a flag (CLI flags/env override it).

### 2. Command matching

- Vendor (or reimplement faithfully, your call, but reuse the real logic
  rather than a naive substring match) `parseCommand` (from
  `zoo-code/src/shared/parse-command.ts`) and the matching/decision logic
  from `zoo-code/src/core/auto-approval/commands.ts` — specifically
  `containsDangerousSubstitution` and the allow/deny regex-matching approach
  (`getCommandDecision` or equivalent — read the file, don't assume the
  exact export name). Put the ported/reimplemented version under
  `src/permissions/commands.ts`.
- In `executeCommandHandler` (`src/tools/executor.ts`), before spawning:
  - If `containsDangerousSubstitution(command)` is true: refuse
    unconditionally (`isError: true`, clear message explaining why) —
    this is not configurable, it's always blocked, matching upstream's own
    "never auto-approved" treatment of these patterns.
  - Otherwise, check the command (each sub-command from `parseCommand` if
    it's a compound command) against `deniedCommands` first (deny wins if
    both an allow and a deny pattern match — verify this is the *actual*
    precedence order in the vendored logic, don't assume), then
    `allowedCommands`.
  - **Decide the default-deny-vs-default-allow behavior deliberately and
    document it clearly** (this is a real judgment call, not an oversight
    to fix silently): if `allowedCommands` is unset/empty, should commands
    be allowed by default (matches "nothing configured, no change from
    today") or denied by default (safer for an unattended agent, but a
    behavior change that could break existing workflows/tests without an
    explicit config)? Recommend: default-allow when `allowedCommands` is
    unset (preserves today's behavior for anyone not opting in), but
    `deniedCommands` always applies even when empty-allowed-list means
    "allow everything else." State your choice explicitly in your report.

### 3. Protected files

- In `writeToFileHandler` (`src/tools/executor.ts`), before writing: check
  the target path against the resolved protected-files glob list. If
  matched, refuse (`isError: true`, clear message naming which pattern
  matched and how to override if the CLI/config explicitly allows writes to
  protected files — e.g. an explicit `--allow-protected-writes` escape
  hatch for legitimate cases like a task that's specifically about rotating
  a key file, off by default).
- Simple glob matching is fine — check if this project already has a glob
  utility anywhere (grep for existing glob usage, e.g. in
  `src/vendor/zoo-code/src/services/checkpoints/excludes.ts` from the
  recently-added checkpoint work, which may already have exclude-pattern
  matching logic you can reuse or mirror) before adding a new dependency;
  only add a glob library if nothing suitable already exists in the vendored
  tree or `node_modules`.

### 4. Visibility

- When a command or write is refused, the refusal message returned to the
  model must be clear enough that a well-behaved model adjusts its approach
  (matches the existing error-message quality bar elsewhere in
  `executor.ts` — look at existing `err(...)` messages for the tone/format
  to match).
- A refusal is a real tool error (`isError: true`) and DOES count toward the
  consecutive-mistake bounded-failure counter — unlike the
  execute_command-timeout fix (a separate task) which deliberately does NOT
  count as a mistake. A permissions refusal is a case where the model tried
  to do something it isn't allowed to do, which is exactly what that counter
  exists to catch repeated instances of.

## What NOT to do

- Do not build a settings UI or webview — there isn't one and won't be one.
- Do not touch checkpoints, decision-escalation, dashboard, or the
  orchestrator's rework logic — scoped entirely to `src/tools/executor.ts`
  plus the new `src/permissions/` module and the new CLI flags in
  `src/cli.ts`.
- Do not make protected-files or command-matching apply to the read-only
  reviewer/QA executors' `execute_command` — those already can't write
  files; whether to gate their command execution too is a judgment call,
  default to applying the SAME allow/deny logic there too (since QA/review
  sessions also run unattended and could run arbitrary commands), but do
  NOT apply protected-file write checks there (there's no `write_to_file`
  registered for those executors to begin with, nothing to check).

## Tests

New `src/permissions/__tests__/commands.test.ts`: dangerous-substitution
patterns always refused regardless of config; deny-list match refused even
when also allow-listed; allow-list-only commands pass when unset (default
behavior you chose); compound commands (`&&`/`;`/`|`) checked per
sub-command, not as one opaque string (a `rm -rf /` hidden after an allowed
`echo hi &&` must still be caught).

New `src/permissions/__tests__/protected-files.test.ts`: `.env` refused by
default; a custom pattern list refuses/allows as configured; the escape
hatch flag actually works when explicitly set.

Extend `src/tools/__tests__/` executor tests: a denied command via
`execute_command` returns `isError: true` with a clear message and DOES
increment the mistake counter (session-level test); a protected-file write
via `write_to_file` is refused the same way.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. All five e2e suites under `scripts/e2e*/run.sh` still pass — if any
   existing e2e fixture happens to run a command or write a file that would
   now be denied by your CHOSEN defaults, that's important to know: either
   the default is too aggressive (reconsider it) or the fixture needs an
   explicit allow-list entry (document why). Don't just patch e2e fixtures
   silently to make them pass without understanding why they broke.

## What to report back

- Files changed/added.
- Confirmation of tsc/test/e2e results (actual pass/fail counts).
- The exact default-allow-vs-default-deny decision you made for commands,
  and the default protected-file pattern list you shipped, with reasoning.
- Any deviation from this spec, and why.
- Anything you noticed while doing this that looks like a related bug or
  gap, even if unfixed — flag it rather than ignoring it.
