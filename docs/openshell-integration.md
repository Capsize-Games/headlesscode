# OpenShell integration

HeadlessCode can run workers in NVIDIA OpenShell sandboxes through a Docker-backed gateway. The sandbox works in a disposable clone; the host worktree and orchestration files are not mounted into it. After sandbox deletion, HeadlessCode validates and imports a Git bundle into the host branch.

## Set up a gateway

| Requirement | Configuration |
| --- | --- |
| OpenShell CLI | Install and select a Docker-backed gateway on the same host as HeadlessCode. |
| Driver options | Enable Docker driver configuration and bind mounts for the gateway. Restrict gateway access to trusted operators. |
| Scratch visibility | Create the configured scratch root before starting the gateway, and bind-mount it into the gateway container at the same absolute path. Default: `~/.local/share/headlesscode/openshell-sessions`. |
| Supervisor callback | The sandbox's Docker bridge must be able to reach the gateway callback address and port. Keep the CLI endpoint loopback-bound where possible; publish a separate bridge-address callback listener if needed. |
| Worker image | Build `headlesscode-openshell:local` from the source checkout. It contains the HeadlessCode runtime, Node.js, Git, Bash, certificates, `timeout`, and coreutils. Add project-specific tools in a derived image. |

Follow NVIDIA's [gateway configuration](https://docs.nvidia.com/openshell/dev/manage/gateways/configuration) and [Docker driver reference](https://docs.nvidia.com/openshell/dev/reference/sandbox-compute-drivers). The sample policy and gateway configuration are starting points; check network access and mount settings for the target project.

For a Compose gateway, create the host directory before starting Compose and add a bind mount with identical source and target paths. For example, with the default Linux path:

```yaml
services:
  gateway:
    volumes:
      - type: bind
        source: ${HOME}/.local/share/headlesscode/openshell-sessions
        target: ${HOME}/.local/share/headlesscode/openshell-sessions
```

Create it with `mkdir -p "$HOME/.local/share/headlesscode/openshell-sessions"` and ensure the HeadlessCode user can write there. If the gateway container uses a different home path, use the host absolute path as its target too; the Docker driver and daemon must resolve the same host source.

## Launch workers

Import the profile, set the OpenRouter credential and reviewed policy, then select OpenShell:

```sh
docker build -f docker/OpenShell.Dockerfile -t headlesscode-openshell:local .
openshell profile import -f shared/openshell/headlesscode-openrouter.yaml
export HEADLESSCODE_OPENROUTER_API_KEY=sk-or-...
export HEADLESSCODE_OPENSHELL_POLICY="$PWD/shared/openshell/headlesscode-policy.yaml"
headlesscode orchestrate --repo /path/to/repo --issue 42 --execution-provider openshell
```

`headlesscode watch` accepts the same `--execution-provider openshell` option. The one-off `headlesscode openshell-session --repo <path> --task <text>` command runs a single task and leaves its worktree available for review. Provider credentials are injected by OpenShell and are not passed as ordinary sandbox environment arguments.

If the scratch path differs from the default, create it before starting the gateway, mount it into the gateway container at the same absolute path, and set `HEADLESSCODE_OPENSHELL_SCRATCH_ROOT` to it. A host path that is not mounted into the gateway container will fail during sandbox provisioning.

## Session boundary and result import

| Data | Sandbox handling | Returned to host? |
| --- | --- | --- |
| Workspace | Independent Git clone at `/workspace`, writable during the session. The host worktree is not a bind source. | Yes. A Git bundle is imported only after sandbox deletion and validation. |
| Export directory | Separate scratch mount at `/result`; holds the result bundle. | Bundle is validated for size, branch, ancestry, and host branch state before import. |
| Project data and shared instructions | Copied into scratch and mounted as separate read-only paths. The original central data directory is not mounted. | No. |
| Checkpoints | Separate writable scratch path. | Available while the session runs; the disposable checkpoint history is discarded at teardown. |
| Memory | Opt-in snapshot under the same scratch root, writable only inside the sandbox. | Valid JSONL records in the supported `facts/` and `sessions/` layout are merged after sandbox deletion. |
| Harness and process-control files | Harness runtime comes from the image. Host PID files, completion markers, and Git metadata are not mounted. | The host worker wrapper writes its own completion markers after the remote command returns. |

The host worktree is checked against the session's starting commit before import. The returned bundle must contain only the expected branch and retain the starting commit as an ancestor. The provider then updates the assigned branch with an old-object guard and resets the host worktree to that branch. Reviewer and QA sandboxes can disable result import.

OpenShell Landlock permissions are additive. A read-only rule below a writable parent does not revoke the parent's write access. The earlier implementation mounted the host worktree writable and a live probe showed writes to host Git and process-control files. That layout was removed. The current provider mounts a disposable clone instead; the host worktree and its `.git` pointer/configuration and control markers are outside sandbox mounts.

The sandbox can modify its own clone Git metadata. Only one expected branch is exported, and the host checks the bundle before import. This does not make arbitrary project code safe to run on the host after import; review code changes before executing them.

The clone contains the repository's committed files and Git history. For an untracked `.env`, the sandbox working copy contains only the allowlisted port and Compose settings used by the worker. A tracked `.env` is likewise filtered in the working copy and restored before export, but its committed contents remain readable through Git history inside the sandbox. Do not commit credentials or other secrets to the repository.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `--execution-provider` / `HEADLESSCODE_EXECUTION_PROVIDER` | `local` | Selects the provider for `orchestrate` and `watch`; values are `local` or `openshell`. |
| `HEADLESSCODE_OPENSHELL_POLICY` | unset | Required path to the base OpenShell policy YAML. |
| `HEADLESSCODE_OPENSHELL_IMAGE` | `headlesscode-openshell:local` | Worker sandbox image. |
| `HEADLESSCODE_OPENSHELL_PROVIDERS` | `headlesscode-openrouter` | Comma-separated OpenShell credential profiles. |
| `HEADLESSCODE_OPENSHELL_CPU` / `HEADLESSCODE_OPENSHELL_MEMORY` | `2` / `4Gi` | Resource requests per sandbox. |
| `HEADLESSCODE_OPENSHELL_NAME_PREFIX` | `hcls` | Prefix for deterministic sandbox names. |
| `HEADLESSCODE_OPENSHELL_SCRATCH_ROOT` | `~/.local/share/headlesscode/openshell-sessions` | Host scratch root, which must be available to the gateway and Docker daemon at the same absolute path. |

NVIDIA Sentry, BlueField enforcement, hardware telemetry, quarantine, and hardware-level containment are not configured by this integration.

## Validation

The OpenShell 0.1.2 Docker gateway ran `headlesscode openshell-session` with `deepseek/deepseek-v4-flash-0731` through OpenRouter. The harness completed with exit code 0; the model wrote and committed a file, and the host imported the bundle after sandbox deletion. A live in-sandbox probe confirmed the host repository `.git/config`, host worktree `.git` pointer, and harness marker paths were absent; creating a canary file in the host worktree was denied. The sandbox workspace and result directory remained writable.

The gateway callback path was tested through the Docker bridge. Local provider lifecycle tests and TypeScript typechecking also passed. These checks validate the local Docker configuration and result flow; they do not verify other gateway deployments, NVIDIA Sentry, or hardware enforcement.
