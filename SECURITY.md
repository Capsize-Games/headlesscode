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

## Reporting vulnerabilities

This project is pre-1.0 and has no private disclosure channel yet. For now,
report security findings by opening a GitHub issue on
[Capsize-Games/headlesscode](https://github.com/Capsize-Games/headlesscode)
tagged `security`, or a pull request with a fix. See the project's
[`headless-coding-harness-project.md`](headless-coding-harness-project.md) for
the overall design.

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
