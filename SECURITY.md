# Security Policy

## Arbitrary command execution — read this first

`headlesscode` is a headless coding-agent harness: it runs an LLM in a loop
and lets the model **execute arbitrary shell commands on the machine that runs
it, as the invoking user** (`src/tools/executor.ts` → `child_process` → bash).
This is the tool's core function, not a bug — but it has direct security
consequences for anyone who runs it:

- **The model you point it at controls your shell.** Any prompt, repository
  content, or tool output that reaches the model can influence the commands it
  runs. Treat an unattended `headlesscode` session the same way you would
  treat an unattended root shell: it is only as trustworthy as the model, the
  prompt, and the repository it is pointed at.
- **The permission layer is opt-in and defaults to allow.** Command
  allow/deny lists, protected-file checks, and the central-store protection
  exist (`src/permissions/`), but `allowedCommands` defaults to `[]`, which
  the command-decision layer treats as "allow everything except the deny
  list". Denied commands and protected files always apply; everything else
  runs unless you configure a policy. See
  `src/permissions/config.ts` for the full precedence
  (CLI flags > env vars > central `permissions.json` > built-in defaults).
- **Run it with least privilege.** Do not run `headlesscode` as root or with
  broad credentials in the environment. Use a dedicated, unprivileged user,
  a container/VM with no sensitive mounts, or a service account with only the
  scopes a session needs. The harness is designed to be isolated per session
  (`git worktrees`, containers/VMs behind the `CloudProvider` abstraction in
  `src/cloud/`) — use that isolation.
- **Protect your secrets.** The model sees whatever is in the workspace and
  environment. Do not put API keys, tokens, or credentials where a session can
  read them unless the session genuinely needs them.

## Reporting a vulnerability

This project is in its early development phase (see the project plan in
`headless-coding-harness-project.md`). If you believe you have found a
security vulnerability — including in the command-execution or permission
model described above — please report it privately:

- **Open a GitHub issue with the `security` label** at
  <https://github.com/Capsize-Games/headlesscode/issues/new> — the project
  maintainers triage the issue tracker; mark the issue as sensitive and avoid
  including live credentials or private keys in the report.
- For anything involving credentials, live infrastructure, or a vulnerability
  you believe is being exploited, email the maintainers directly (address on
  the repository profile) and include a minimal reproduction. Do **not** open
  a public issue for those.

We aim to acknowledge reports within 5 business days and to ship a fix (or a
documented workaround) for confirmed issues. When you report, please include:

1. The version/commit you tested.
2. A minimal reproduction (the command, the prompt, or the configuration that
   triggers it).
3. Impact: what an attacker could do, and under what assumptions about the
   deployment (e.g. "runs as root in CI with a `GITHUB_TOKEN` in the
   environment").

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
