# Security

## TL;DR

`headlesscode` is a **headless coding-agent harness**: an AI model reads a task,
then drives your machine by running shell commands and editing files. By design,
an unconfigured session runs **arbitrary commands with your full user
privileges** and can **read and modify your files** — including `~/.ssh`,
`~/.aws`, and any other credentials the user can access.

**Run it only on a machine you are willing to let an AI operate, only on
repositories you trust, and only with untrusted content isolated from your real
session.** This project does not sandbox agent actions, and nothing in the
harness can be relied upon to stop a malicious or compromised model that has
been given the ability to execute commands.

## Default-allow command execution

An unconfigured session gives the agent:

- **Arbitrary shell command execution.** `execute_command` spawns the
  model-supplied command string with `shell: true`, the full process
  environment, and no sandbox (see
  [`src/tools/executor.ts`](src/tools/executor.ts:1286) and
  [`src/permissions/commands.ts`](src/permissions/commands.ts:834)). The
  command runs as **you** — the same OS user, with the same files, network
  access, and credentials the harness process has. There is no per-command
  approval prompt (the harness is non-interactive by design), no container, and
  no privilege boundary.
- **File read/write.** The write tools (`write_to_file`, `apply_diff`,
  `search_replace`, `edit_file`) can create and overwrite any file under the
  workspace root. Reads are not restricted at all.

An empty `allowedCommands` list means **allow everything** — only the
`deniedCommands` list (also empty by default) restricts anything. This is a
deliberate design choice for a headless tool: it preserves the behavior of a
local CLI that a developer runs in their own checkout. It is **not** a security
boundary.

### What this means in practice

With default settings, an agent can, for example:

- Read `~/.ssh/id_rsa`, `~/.aws/credentials`, or any other file the user can
  read.
- Exfiltrate data over the network (`curl`, `scp`, `gh`, …).
- Modify, delete, or encrypt files; install software; change system
  configuration.
- Persist backdoors or leave any other modification on the machine.

Do not point this at data or machines where that outcome would be
unacceptable, and do not feed it untrusted task text or repository content you
have not reviewed.

## When untrusted content is involved

If the task text, the repository, or anything the agent will read could be
hostile, treat the agent as untrusted code running as your user. The only safe
mitigation is OS-level isolation **outside** this project — for example a
throwaway container, VM, or dedicated user account with no access to your real
credentials:

- No credentials (SSH keys, cloud tokens, API keys) mounted unless the task
  genuinely needs them.
- No writable access to anything you care about beyond a scratch workspace.
- Network access limited if exfiltration is a concern.

The harness itself cannot provide this isolation, and no amount of prompt
engineering, rules files, or "trusted mode" configuration is a substitute for
it.

## Browser and vision cloud data flow

Two agent-driven tools send data off the machine as part of their normal
operation — not a bug, but worth knowing before pointing either at anything
sensitive:

- **Browser tool.** `browser_action` (see
  [`src/tools/browser/service.ts`](src/tools/browser/service.ts:112)) launches
  a headless Chromium instance and navigates it to whatever URL the model
  supplies. The page content, cookies set by the site, and any redirects are
  fetched directly by the browser process on your machine/network — the same
  as visiting the URL yourself. If the model is given (or invents) a URL for
  an internal or sensitive endpoint, that page's content becomes visible to
  the model in its response.
- **Vision (image description).** `describeImage`
  (see [`src/vision/describe.ts`](src/vision/describe.ts:118)) base64-encodes
  a screenshot or workspace image and POSTs it to OpenRouter
  (`openrouter.ai`, or `HEADLESSCODE_VISION_MODEL`'s configured provider) for
  captioning, then feeds the description back into the model's context. The
  image bytes themselves leave the machine and are processed by a third-party
  cloud model, subject to that provider's own data-handling policy.

Neither flow has a local-only mode today. Do not use `browser_action` against
URLs, or `describeImage` against screenshots/images, that contain data you
would not otherwise send to a third-party cloud API.

## The permissions mechanism (defense in depth, not a boundary)

The harness ships an optional permissions layer that can restrict what the
agent does — see [`docs/central-store.md`](docs/central-store.md) and
[`src/permissions/config.ts`](src/permissions/config.ts). It includes:

- `--allowed-commands` / `--denied-commands` (or
  `HEADLESSCODE_ALLOWED_COMMANDS` / `HEADLESSCODE_DENIED_COMMANDS`, or a
  central `permissions.json`) — allow/deny prefix matching for commands.
- `--protected-files` / `HEADLESSCODE_PROTECTED_FILES` — glob patterns of files
  the write tools refuse to touch (defaults protect `.env`, `*.pem`, `*.key`,
  `id_rsa*`).
- `--allow-protected-writes` — explicit escape hatch that bypasses the
  protected-files check (OFF by default).

This layer is useful defense in depth against accidents and makes refusal
messages actionable, but it is a **prefix-match policy on a command string**, not
a sandbox. A malicious or sufficiently capable model can evade it (e.g. by
writing a script and running it, or by abusing any command that is allowed), so
**do not rely on it to contain untrusted code.** Restricting commands does not
restrict what the agent can *read* or what allowed commands can accomplish.

## Known limitations (tracked audit findings)

These are specific, known gaps in the defense-in-depth layers above — not new
risks beyond the "not a sandbox" scope already documented, but concrete ways
the prefix-match and pattern-based checks can be evaded. Documented here per
the project's own audit process rather than silently left implicit.

- **Deny-list is a raw-string prefix match, not a program-identity check**
  (`src/permissions/commands.ts` — `findLongestPrefixMatch`). A deny entry of
  `rm` is trivially evaded by `command rm`, `/bin/rm`, `env rm`, `xargs rm`,
  or `python -c "shutil.rmtree(...)"` — none of these share the `rm` prefix.
  The allow/deny mechanism is prefix matching on the literal command string by
  design (ported verbatim from upstream for parity); it does not resolve
  `argv[0]`, follow `PATH`, or understand that many programs can accomplish
  the same effect. Treat every deny-list entry as a speed bump against
  accidental/careless commands, never as a guarantee that a given program
  cannot run.
- **Central-store protection (`src/permissions/store-protection.ts`) is
  pattern-based, not a sandbox.** As of the SEC-6 fix it protects the store
  root, its ancestors, AND its descendants, and it follows symlinks
  (`fs.realpathSync`) and tracks a leading `cd <dir> &&` chain's effective
  cwd. It still does **not** catch: `cd` performed inside a subshell
  (`(cd /x && rm -rf y)`) or via a shell variable/`pushd`/`popd`; `sudo rm`;
  non-`rm` deletion (`find ... -delete`, `python -c shutil.rmtree(...)`, a
  script that deletes the store); or a non-recursive `rm` of a single file
  inside the store. It only recognizes GNU/POSIX `rm` flag syntax.
- **The dashboard's local HTTP server gates only POST routes with the bearer
  token** (`HEADLESSCODE_DASHBOARD_TOKEN`); GET routes that list/read
  workspace files, checkpoints, codemap, cost history, and projects are
  reachable by any request that can reach `127.0.0.1` on the dashboard port
  (including via DNS-rebinding or localhost-CSRF from a browser tab open to a
  malicious page). Do not run the dashboard on a shared or multi-user machine
  without additional network isolation (see also
  [`src/dashboard/files.ts`](src/dashboard/files.ts) and
  [`src/dashboard/trend.ts`](src/dashboard/trend.ts)).
- **`execute_command` children inherit the full process environment,**
  including `HEADLESSCODE_OPENROUTER_API_KEY` and any other secret exported
  into the harness's own env. `protected-files.ts` only prevents the agent
  from *writing* `.env`; nothing stops the agent from reading its own
  process's environment (`printenv`, `env`) and having that flow into the LLM
  context. Acceptable for the documented trusted-single-user model; a real
  constraint if this project is ever run multi-tenant (see
  `docs/multi-tenant-hosting-design.md`) — don't put shared secrets in a
  session's environment that a given task should not be able to see.

## Reporting vulnerabilities

This project is pre-1.0 and has no private disclosure channel yet. For now,
report security findings by opening a GitHub issue on
[Capsize-Games/headlesscode](https://github.com/Capsize-Games/headlesscode)
tagged `security`, or a pull request with a fix. See the docs in `docs/` for
the overall design.

## Supported versions

Only the current `master` branch is supported. The project has not cut
releases yet (no tags, `version: 0.1.0`); patches land on `master` and are
expected to be forward-only.

## Security-relevant areas

If you are auditing the codebase, the highest-value targets are:

- `src/tools/executor.ts` — the tool executor, including the
  `execute_command` handler that spawns shell commands and the path-traversal
  guard for file tools.
- `src/permissions/` — command allow/deny, protected files, and the
  central-store protection; defaults are documented in `config.ts`.
- `src/cloud/` and `src/orchestrator/` — session isolation, worktree
  spawning, and the scripts they shell out to (`scripts/*.sh`).
- `src/vendor/zoo-code/` — the vendored Apache-2.0 portable core (see
  `ATTRIBUTION.md`); upstream security fixes should be tracked via
  `VENDOR-NOTES.md`.

The npm package (`npm pack`) ships only the runtime source under `src/`
(excluding `__tests__/`), `shared/`, and the top-level docs — internal
`plans/`, `recon/`, `.roo/`, and dev scripts are intentionally excluded (see
the `files` field in `package.json`).

## Responsible-use checklist

Before running `headlesscode` on anything you care about:

1. Confirm you are running it as a user whose privileges you are willing to
   expose to the agent (ideally a dedicated, unprivileged account).
2. Confirm the workspace and task are trusted, or the environment is isolated
   (container/VM) so the blast radius is contained.
3. Review the command permissions (`--allowed-commands` /
   `--denied-commands`) and protected files (`--protected-files`) if you want
   the defense-in-depth layer on.
4. Never run it with credentials or secrets mounted that the task does not
   need.
