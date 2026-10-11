# headlesscode

[![CI](https://github.com/Capsize-Games/headlesscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Capsize-Games/headlesscode/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/headlesscode?logo=npm)](https://www.npmjs.com/package/headlesscode)
[![Node.js >=22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[License: Apache-2.0](./LICENSE)

`headlesscode` runs the Zoo Code agent loop from a Node.js process, without a
VS Code window. Run one task directly, launch parallel workers in Git
worktrees, or use the NVIDIA OpenShell provider for sandboxed sessions.

## Security controls

HeadlessCode's controls map to the seven principles in Satya Nadella's
[Models as Insider Risks in the Super Intelligence Era](https://snscratchpad.com/posts/models-as-insider-risks/).

| Principle | HeadlessCode implementation |
| --- | --- |
| **Model diversity** | Operators assign models by mode and RSI role, including review and adversarial roles. Programmatic gates determine candidate eligibility. See [model assignment](./src/config/mode-models.ts) and [RSI roles](./src/rsi/roles.ts). |
| **Observe everything** | Evidence-required sessions wait for an external collector's authenticated acknowledgement before model calls and tool actions. The collector signs a hash-linked journal and session head; an offline verifier produces a readable history and distinguishes worker reports from supervisor observations. See [evidence journal](./docs/evidence-journal.md). |
| **Verifiability** | CI runs typechecking, the full automated suite, and mock workflows. Tests exercise missing evidence acknowledgements, tampering, replay, stop races, and cleanup failures. RSI applies regression and frozen proof gates; configured hidden verification checks bounded function cases against supervisor-held answers. See [CI](./.github/workflows/ci.yml) and [hidden verification](./docs/security-verification.md). |
| **Independent controls** | Operators configure command and file permissions, resource and inference budgets, and a contained profile that pins the OpenShell policy, image, gateway, evidence key, and emergency controller. Launch preflight checks those identities and the sandbox's effective policy. See [permissions](./src/permissions/config.ts) and [security profiles](./docs/security-profiles.md). |
| **Independent auditability** | The external collector owns evidence signing keys and storage. The hidden verifier keeps expected answers and signing keys in the supervisor, binds reports to the candidate source, session, job, limits, and one-time nonce, and compares outputs outside the candidate guest. See [evidence boundaries](./docs/evidence-journal.md#trust-and-deployment-boundary) and [hidden verification](./docs/security-verification.md). |
| **Containment** | OpenShell runs sessions in disposable independent clones. The host emergency controller can pause or stop active work, abort model calls, terminate scoped command groups, and delete sandboxes. Result import requires confirmed sandbox deletion. See [emergency controls](./docs/emergency-control.md) and [OpenShell lifecycle](./src/cloud/openshell-provider.ts). |
| **Incident disclosure** | GitHub private vulnerability reporting provides confidential intake. The incident procedure covers containment, evidence preservation, fixes, affected-user notification, coordinated advisories, and review of failed controls and runtime configuration changes. See [incident response](./docs/incident-response.md), [report a vulnerability](https://github.com/Capsize-Games/headlesscode/security/advisories/new), and [advisories](https://github.com/Capsize-Games/headlesscode/security/advisories). |

| Use it for | What it does |
| --- | --- |
| One repository task | Reads project modes and instructions, edits files, runs commands, and reports a result. |
| Parallel issue work | Splits GitHub issues into Git worktrees, runs workers, monitors completion, and reviews changes. |
| Intake automation | Watches a GitHub label and starts bounded batches of work. |
| OpenShell sessions | Runs worker and review sessions in disposable clones, then validates and imports results after sandbox deletion. |
| Harness experiments | Runs a bounded recursive self-improvement loop against an external evaluator. |

## Security

> **Default-allow arbitrary command execution.** By default, `headlesscode`
> runs shell commands with the invoking user's privileges. It can read and
> modify files, including credentials such as `~/.ssh` and `~/.aws`, without
> approval prompts. Use it only with trusted tasks and isolate it with a
> container, VM, or dedicated user when untrusted content is involved. The
> optional permissions layer is defense in depth, not a security boundary.
> See [`SECURITY.md`](./SECURITY.md).

OpenShell runs each session in a disposable Git clone mounted at `/workspace`;
the host worktree and harness control files are not mounted. After the sandbox
is deleted, HeadlessCode validates a Git bundle and imports the result into the
host worktree. The gateway must support Docker bind mounts and must see the
configured scratch root at the same absolute path as the host. See the
[OpenShell guide](./docs/openshell-integration.md) for setup and security
details. This integration does not configure NVIDIA Sentry or hardware
monitoring.

## Quick start

Requires Node.js 22.19 or newer. Install globally or run with `npx`:

```bash
npm install -g headlesscode
# or
npx headlesscode --task "Fix the bug in src/index.ts" --workspace /path/to/repo
```

For a real model call, set the OpenRouter key. `--dry-run` does not need a key.

| Variable | Required | Purpose |
| --- | --- | --- |
| `HEADLESSCODE_OPENROUTER_API_KEY` | For OpenRouter calls | OpenRouter API key. |
| `OPENROUTER_MODEL` | No | Default model; `meta/muse-spark-1.3-contributor`. `--model` overrides it. |
| `OPENROUTER_HTTP_REFERER` | No | OpenRouter application referer header. |
| `OPENROUTER_APP_TITLE` | No | OpenRouter application title header. |
| `HEADLESSCODE_WORKSPACE_ROOT` | No | Default workspace; otherwise the current directory. |

```bash
export HEADLESSCODE_OPENROUTER_API_KEY=sk-or-...
headlesscode --task "Fix the bug in src/index.ts" --workspace /path/to/repo
```

The default model is Muse Spark 1.3 Contributor through OpenRouter. [OpenRouter lists it](https://openrouter.ai/meta/muse-spark-1.3-contributor) at $0.10/M input tokens, $0.20/M output tokens, and $0.002/M cached
input tokens. OpenRouter notes that prompts and outputs sent to this Contributor
model may be used to improve Meta's products. Use `OPENROUTER_MODEL` or
`--model` to select another OpenRouter model.

### Using Meta's Model API (Muse) instead

Set `HEADLESSCODE_LLM_PROVIDER=muse` to run sessions against Meta's Model
API (`https://api.meta.ai/v1`, OpenAI-compatible) with the Muse Spark
family instead of OpenRouter. Get a key from the
[Model API dashboard](https://dev.meta.ai/). The default model is
`muse-spark-1.3` (1M context); `--model` and `mode-models.json` entries
work the same as on the OpenRouter path. `orchestrate` preflight,
per-session cost budgets, and the local Ollama backend all apply unchanged.

| Variable | Required | Purpose |
| --- | --- | --- |
| `HEADLESSCODE_LLM_PROVIDER` | No | `"openrouter"` (default) or `"muse"`. |
| `HEADLESSCODE_MUSE_API_KEY` | For Muse calls | Meta Model API key (`MODEL_API_KEY` also works). |
| `HEADLESSCODE_MUSE_MODEL` | No | Default model; `muse-spark-1.3`. Shadows `OPENROUTER_MODEL`. |
| `HEADLESSCODE_MUSE_BASE_URL` | No | API base URL; `https://api.meta.ai/v1`. |

```bash
export HEADLESSCODE_LLM_PROVIDER=muse
export HEADLESSCODE_MUSE_API_KEY='LLM|...'
headlesscode --task "Fix the bug in src/index.ts" --workspace /path/to/repo
```

Notes: the `-contributor` model variants (`muse-spark-1.3-contributor`,
`muse-spark-1.2-contributor`) use the [Contributor pricing tier](https://dev.meta.ai/docs/pricing-rate-limits)
and permit Meta to train on the traffic. Select them explicitly when using the
direct Meta API; its default is the Standard model. Vision
captioning (`describe_image`, screenshots) and OpenShell sandboxed
execution still use OpenRouter regardless of this setting.

For a source checkout:

```bash
git clone https://github.com/Capsize-Games/headlesscode.git
cd headlesscode
npm install
node bin/headlesscode.mjs --task "Fix the bug in src/index.ts" --workspace /path/to/repo
```

To install a `headlesscode` wrapper on your `PATH`, run `scripts/install-cli.sh`.
It writes to `~/.local/bin` by default (override with `HEADLESSCODE_BIN_DIR`)
and runs this checkout's local `tsx`. Re-run it if you move the checkout.

### Terminal chat, skills, and saved sessions

`headlesscode chat` starts an interactive conversation. Each turn uses the
existing runner and saves its messages for resume or fork. `/help` lists the
session, model, mode, skill, and import controls.

```bash
headlesscode chat --workspace /path/to/repo
headlesscode skills import /path/to/my-skill
headlesscode sessions import --from codex --file /path/to/rollout.jsonl --workspace /path/to/repo
headlesscode chat --resume <session-id> --workspace /path/to/repo
```

Skills use `SKILL.md` instructions and captured text references. Session
imports support Claude Code, Codex, and Muse history, with provenance and
warnings. Imported tool calls stay historical context. See [terminal chat](./docs/terminal-chat.md),
[skills](./docs/skills.md), and [sessions](./docs/sessions.md) for formats,
discovery, and security behavior.

Coding sessions can also create and use reusable skills, Node tools, and local
stdio MCP servers through `extension_manage` and `extension_call`. Each call
pins an immutable revision and uses the session's existing permissions. The
fixed interfaces keep extension contents out of the system prompt and tool
catalog. See [workspace extensions](./docs/extensions.md) for the bundle format
and runtime limits.

### Check project instructions without calling a model

`--dry-run` builds the system prompt and validates project configuration. It
prints the prompt and a summary of loaded modes, tools, and prompt size. A
successful exit means prompt building and mode/rules loading succeeded.

```bash
headlesscode --dry-run --mode code --workspace /path/to/repo
```

Project `.roomodes`, `.roo/rules-<slug>/`, and `AGENTS.md` instructions are
loaded by the prompt builder when applicable. The selected mode controls which
tools are exposed. See [Architecture](#architecture) for the relevant code.

### Local MCP services

HeadlessCode can connect to user-configured stdio and Streamable HTTP MCP
servers. It reads `~/.config/capsize-agent/mcp.json` by default; set
`HEADLESSCODE_MCP_CONFIG` to use another trusted, user-owned manifest. It does
not execute MCP commands from a workspace `.mcp.json`. Connected server tools
are exposed to modes that allow the `mcp` tool group. Offline servers are
reported in the session prompt/log while other servers continue to work.

The MCP client does not add an approval layer around server tools. Treat each
configured server's capabilities as available to the agent, and use HeadlessCode
only for trusted tasks. See [MCP servers](./docs/mcp.md) for configuration,
limits, and local setup details.

## OpenShell

Build the worker image and import the OpenRouter provider profile once. Configure
a Docker-backed OpenShell gateway with driver-config and bind-mount support;
keep that gateway restricted to trusted operators.

```bash
# Run these commands from a HeadlessCode source checkout.
docker build -f docker/OpenShell.Dockerfile -t headlesscode-openshell:local .
openshell profile import -f shared/openshell/headlesscode-openrouter.yaml

export HEADLESSCODE_OPENROUTER_API_KEY=sk-or-...
export HEADLESSCODE_OPENSHELL_POLICY="$PWD/shared/openshell/headlesscode-policy.yaml"
headlesscode orchestrate --repo /path/to/repo --issue 42 \
  --execution-provider openshell
```

Each worker gets an independent clone and a temporary result directory. Neither
bind source is the host worktree. After the sandbox is deleted, HeadlessCode
imports a verified Git bundle into the host branch. The default scratch root is
`~/.local/share/headlesscode/openshell-sessions`; create it before starting the
gateway and bind-mount it into the gateway container at the same absolute path.
If you choose another root, set `HEADLESSCODE_OPENSHELL_SCRATCH_ROOT` and mount
that host directory into the gateway container at the same path. Project data and shared instructions
are copied into the scratch tree and mounted separately. The writable scratch
checkpoint store supports checkpoints during a session and is discarded at
teardown. Opt-in memory uses a scratch snapshot and merges validated JSONL
records after sandbox deletion. No OpenRouter key is passed as a normal sandbox
environment argument; OpenShell injects the imported provider credential.

`headlesscode watch` accepts the same `--execution-provider openshell` option.
OpenShell applies to worker, plan-first, continuation, reviewer, QA, and rework
sessions. The one-off `headlesscode openshell-session` command runs a single
task and keeps its host worktree for review. Set up a gateway callback address
that the sandbox's Docker bridge can reach; keep the client endpoint loopback
only when possible. Read the [OpenShell guide](./docs/openshell-integration.md)
before adapting the sample gateway or filesystem policy.

| Setting | Default | Meaning |
| --- | --- | --- |
| `--execution-provider` | `local` | `orchestrate`/`watch` runtime: `local` or `openshell`. Also settable with `HEADLESSCODE_EXECUTION_PROVIDER`. |
| `HEADLESSCODE_OPENSHELL_POLICY` | No default | Base OpenShell policy YAML; required for OpenShell sessions. |
| `HEADLESSCODE_OPENSHELL_IMAGE` | `headlesscode-openshell:local` | Sandbox image. |
| `HEADLESSCODE_OPENSHELL_PROVIDERS` | `headlesscode-openrouter` | Comma-separated credential profile names. |
| `HEADLESSCODE_OPENSHELL_CPU` / `HEADLESSCODE_OPENSHELL_MEMORY` | `2` / `4Gi` | Per-sandbox resource requests. |
| `HEADLESSCODE_OPENSHELL_NAME_PREFIX` | `hcls` | Prefix for deterministic sandbox names. |
| `HEADLESSCODE_OPENSHELL_SCRATCH_ROOT` | `~/.local/share/headlesscode/openshell-sessions` | Host scratch directory that the gateway container must see at the same path. |

The `headlesscode openshell-session` command provides a single-session live
entry point; run `headlesscode openshell-session --help` for options.

## Parallel work and GitHub intake

`orchestrate` runs a parallel round from GitHub issue numbers or a JSON file.
It splits work, creates a worktree per group, starts workers, watches for
completion, and reviews results. QA and deployment approval are optional.

```bash
headlesscode orchestrate --repo /path/to/repo --issue 42 --issue 43 --qa
headlesscode orchestrate status --repo /path/to/repo --wait --timeout-ms 7200000
```

`watch` polls GitHub for issues with a chosen label and starts bounded batches.
It requires `GH_TOKEN` or `GITHUB_TOKEN`; it performs intake only. Use a later
`orchestrate` run to monitor, review, QA, or deploy a batch.

```bash
GH_TOKEN=... headlesscode watch \
  --owner my-org --repo /path/to/repo --label needs-agent --run-once
```

| Command | Important options | Behavior and limits |
| --- | --- | --- |
| `headlesscode orchestrate --repo <path>` | Repeat `--issue <n>` or use `--issues-json <file>`; `--execution-provider local|openshell`, `--qa`, `--deploy`, `--no-review`, `--dry-run`, `--max-iterations <n>`, `--max-rework-cycles <n>`, `--max-continuations <n>` | Worktree per group; default review is enabled. OpenShell applies to worker, plan-first, continuation, reviewer, QA, and rework sessions. `--deploy` uses the human-approval gate. |
| `headlesscode orchestrate status --repo <path>` | `--wait`, `--timeout-ms <n>`, `--json` | Reads durable round state; `--wait` blocks until terminal state or timeout. |
| `headlesscode orchestrate stop --repo <path>` | Repeat `--group <name>` | Stops selected groups' worker process trees. |
| `headlesscode watch --owner <o> --repo <path> --label <name>` | `--execution-provider local|openshell`, `--run-once`, `--dry-run`, `--max-per-sweep <n>`, `--max-concurrent-sessions <n>`, `--retry-failed` | Label-based intake. `--dry-run` still needs a GitHub token to list issues, but writes no state and starts no workers. |

Both orchestration and watcher enforce a shared concurrency cap, defaulting to
3 (`HEADLESSCODE_MAX_CONCURRENT_SESSIONS`). Orchestration aborts when the cap
is full; the watcher leaves excess issues pending. The watcher records
idempotency state under `<repo>/.worktrees/.watcher-state.json` by default.
Use `--help` on a command for its complete options. Detailed guides:
[orchestration](./docs/phase2-orchestration.md),
[issue watcher](./docs/phase5-issue-watcher.md),
[QA implementation](./src/qa/qa.ts), and
[deployment gate](./docs/phase4-deploy-gate.md).

## Project registration and search

Registering a project detects its stack, ensures `.gitignore` excludes
`.headlesscode/`, and builds a code-search index and codemap. Indexing calls an
embedding API and can incur charges unless skipped or configured for Ollama.

```bash
headlesscode init --workspace ~/Projects/your-project
headlesscode init --workspace ~/Projects/your-project --skip-index
```

See `headlesscode init --help` for `--skip-codemap` and embedding-backend
options. The CLI also provides `index`, `codemap`, project-store, GitHub App,
and decision-proxy commands; run `headlesscode --help` for the command list
and each subcommand's `--help` for complete usage.

## Recursive self-improvement

`headlesscode improve --dry-run` resolves the base commit and prints planned
candidate worktrees. A real run requires PostgreSQL, a shared S3-compatible
artifact store, and at least one registered `headlesscode rsi-worker`. The
coordinator queues sanitized mutation snapshots and visible evaluation jobs;
workers run each in a fresh OpenShell guest. Fitness, paired baseline
comparison, archives, and selection stay in the coordinator. Hidden evaluation
remains disabled. A 2026-09-29 bounded run used two workers on the same local
OpenShell gateway; both candidate evaluation jobs were leased concurrently.
The run used a temporary `clamp.js` fixture and does not establish general
headlesscode improvement or multi-gateway operation. An earlier bounded run
passed visible checks but made no source change and was rejected.

```bash
npx tsx src/cli.ts improve --repo . --dry-run
npx tsx src/cli.ts improve --repo . --population 2 --generations 1
```

Before starting workers, build the standard and RSI guest images on each
OpenShell gateway host that will run RSI jobs. Build the larger training image
only on gateways whose workers will accept model-training or paired
model-evaluation jobs:

```bash
docker build -f docker/OpenShell.Dockerfile -t headlesscode-openshell:local .
docker build -f docker/OpenShell-RSI.Dockerfile -t headlesscode-openshell-rsi:local .
docker build -f docker/OpenShell-RSI-Training.Dockerfile -t headlesscode-openshell-rsi-training:local .
```

The RSI Dockerfile extends `headlesscode-openshell:local` and removes the RSI
source, test files, and hidden evaluation suite from the guest image. See the [RSI design](./docs/recursive-self-improvement.md)
for worker and queue configuration.

The queue stores job state, worker registrations, leases, retries, and admission
policy in PostgreSQL; artifact bytes remain in object storage. Local integration
tests used 12 simulated workers and 100 queued jobs, including a 20 MiB artifact. Each
worker process currently runs one guest at a time and must be configured with a
unique worker ID and OpenShell gateway ID. The two-worker run observed 4.008
seconds of concurrent evaluation leases on one gateway. A local PostgreSQL/
RustFS test drained the remaining 96 jobs with 12 simulated workers in 446 ms
(215.2 jobs/s), after the initial four jobs were claimed and completed to
verify admission limits;
claims still serialize on a queue-policy row, and neither result qualifies a
multi-host deployment. Remaining work is:

| Issue | Work |
| --- | --- |
| [#3](https://github.com/Capsize-Games/headlesscode/issues/3) | OpenShell candidate isolation is implemented; live multi-gateway qualification remains. |
| [#4](https://github.com/Capsize-Games/headlesscode/issues/4) | Content-addressed artifacts are implemented; signed evaluator provenance and hidden evaluation remain. |
| [#5](https://github.com/Capsize-Games/headlesscode/issues/5) | PostgreSQL queue, leases, retries, admission, and configured workers are implemented; live fleet qualification remains. |
| [#6](https://github.com/Capsize-Games/headlesscode/issues/6) | Bounded adaptive independent search supports an initial population plus one evidence-driven follow-up; repeated stages remain out of scope. |
| [#7](https://github.com/Capsize-Games/headlesscode/issues/7) | Fixture-backed curriculum replay and explicit promotion are implemented; wording-to-capability measurement remains unproven. |
| [#8](https://github.com/Capsize-Games/headlesscode/issues/8) | Adversarial review and bounded OpenShell break tests are implemented; live provider-backed review is unvalidated. |
| [#9](https://github.com/Capsize-Games/headlesscode/issues/9) | An OpenShell QLoRA prototype is covered by mocked job tests; the supplied GGUF is rejected before enqueue, and no live training is validated. |

See the [RSI design](./docs/recursive-self-improvement.md) and
[run progress](./docs/rsi-progress.md).

## Core CLI options

| Option | Default or source | Purpose |
| --- | --- | --- |
| `--task <text>` / `--task-file <path>` | One is required unless `--dry-run` | Task prompt; task file is resolved relative to the workspace. |
| `--workspace <path>` | `HEADLESSCODE_WORKSPACE_ROOT` or current directory | Repository directory exposed to the worker. |
| `--mode <slug>` | `code` | Built-in or project `.roomodes` mode. |
| `--model <id>` | `OPENROUTER_MODEL` or `meta/muse-spark-1.3-contributor` (`HEADLESSCODE_MUSE_MODEL` or `muse-spark-1.3` with `HEADLESSCODE_LLM_PROVIDER=muse`) | Model ID. |
| `--max-iterations <n>` | 250 for direct CLI sessions; orchestrator workers default to 50 | Per-session loop bound. |
| `--consecutive-error-limit <n>` | 3 (local code backend may use 6) | Consecutive tool/model errors before stopping. |
| `--max-cost-usd <n>` / `--max-duration-ms <n>` | `HEADLESSCODE_MAX_COST_USD` / `HEADLESSCODE_MAX_DURATION_MS`; disabled if unset | Per-session budget caps. A tripped cap aborts the session. |
| `--memory-dir <path>` / `--no-memory` | Off unless `HEADLESSCODE_MEMORY_DIR` or option is set | Enable project facts and rolling session summaries, or explicitly disable. |
| `--allowed-commands <list>` / `--denied-commands <list>` | CLI, environment, `.headlesscode/permissions.json`; allow list is empty by default | Command-prefix policy. Denials win; dangerous shell substitutions are blocked. See [`SECURITY.md`](./SECURITY.md). |
| `--protected-files <globs>` / `--allow-protected-writes` | `.env,.env.*,*.pem,*.key,id_rsa*` | Block writes matching protected files; explicit escape hatch. |
| `--dry-run` | Off | Build prompt and validate configuration without a model call or API key. |
| `--log-file <path>` | No file | Also append structured session logs to a file. |

Run `headlesscode --help` for advanced controls such as context condensation,
checkpoints, recursive delegation, session pause, and LLM timeout. Some options
are backend-specific; help output and source defaults are authoritative.

## Architecture

The core loop builds the project-specific prompt, calls the configured model,
executes the selected mode's available tools, and repeats until completion or a
configured limit. File tools are confined to the workspace path; shell commands
run with the process user's privileges unless an external boundary such as
OpenShell is configured. Mode instructions and safety controls are distinct:
prompt instructions guide the model, while filesystem or command restrictions
must be enforced by the runtime or sandbox.

| Area | Entry points | Responsibility |
| --- | --- | --- |
| CLI and session loop | [`src/cli.ts`](./src/cli.ts), [`src/engine/`](./src/engine/) | Command dispatch, prompt construction, LLM/tool loop, iteration and context limits. |
| Model and tools | [`src/llm/`](./src/llm/), [`src/tools/`](./src/tools/) | OpenRouter client, tool execution, output handling, and workspace path checks. |
| Parallel orchestration | [`src/orchestrator/`](./src/orchestrator/), [`scripts/spawn-parallel-worktrees.sh`](./scripts/spawn-parallel-worktrees.sh) | Issue grouping, worktree workers, completion state, review, rework, QA, and deploy gating. |
| GitHub intake | [`src/watcher/`](./src/watcher/) | Label polling, durable idempotency, pending work, and bounded spawning. |
| Runtime providers | [`src/cloud/`](./src/cloud/) | Local process, Docker, and OpenShell implementations of the session lifecycle. `orchestrate` and `watch` can select OpenShell for worker sessions. |
| Memory and budgets | [`src/memory/`](./src/memory/), [`src/budget/`](./src/budget/) | Opt-in project memory, cost/time budgets, and session concurrency accounting. |
| QA and deploy gate | [`src/qa/`](./src/qa/), [`src/deploy/`](./src/deploy/) | Read-only QA verdicts and explicit human approval before deployment. |
| Project map and search | [`src/codemap/`](./src/codemap/), [`src/codesearch/`](./src/codesearch/) | Deterministic module maps and repository search indexes. |

The model only receives tools supported by the selected mode and executable
runtime. Unsupported vendored tool schemas are not advertised. This keeps the
model's action set aligned with the current executor; it does not make arbitrary
shell commands safe by itself.

## Development

| Command | Purpose |
| --- | --- |
| `npm install` | Install dependencies. |
| `npm run typecheck` | TypeScript type check. |
| `npm run smoke` | Vendored prompt-builder smoke test; no network. |
| `npm test` | Unit tests using local/fake dependencies where provided. |
| `npm run cli -- --dry-run --workspace .` | Build this repository's system prompt. |
| `bash scripts/e2e/run.sh` | Phase 1 CLI integration against mock OpenRouter. |
| `bash scripts/e2e-phase2/run.sh` | Orchestrator spawn/watch/review integration. |
| `bash scripts/e2e-phase4/run.sh` | QA and deploy-gate integration with fake deploy. |
| `bash scripts/e2e-phase5/run.sh` | Watcher integration against fake GitHub and stubbed spawner. |
| `bash scripts/e2e-phase6/run.sh` | Budget-abort and concurrency-cap integration. |

Unit tests can inject a fake LLM client into `HeadlessSession`; the listed
end-to-end scripts use local mock services. OpenShell provider tests use a
fake CLI. A live OpenShell 0.1.2 run called DeepSeek V4 Flash through OpenRouter,
imported its Git result, and denied a host-worktree canary write. The earlier
shared-worktree mount was removed after a live probe showed it exposed host Git
and control files. See the [OpenShell guide](./docs/openshell-integration.md)
for the current clone-and-import boundary and its validation.

## Implementation status

| Area | Status | Details |
| --- | --- | --- |
| Runtime engine | Implemented | Portable Zoo Code core, model client, tool executor, parser, CLI, and tests. |
| Orchestration | Implemented | Parallel worktrees, issue splitting, status tracking, review, and recovery. See [guide](./docs/phase2-orchestration.md). |
| Memory | Implemented | Opt-in per-project facts and session summaries with a local store; remote store remains a stub. |
| QA and deploy approval | Implemented | Read-only QA plus a fail-closed human-approval deploy gate. See [orchestration guide](./docs/phase2-orchestration.md) and [deploy gate](./docs/phase4-deploy-gate.md). |
| GitHub watcher | Implemented | Poll-based label intake; webhook server is not implemented. See [guide](./docs/phase5-issue-watcher.md). |
| Budget and concurrency controls | Implemented | Per-session limits and a cross-process concurrency cap. |
| Local process provider | Implemented | Existing host-process worker path behind the provider lifecycle interface. |
| Docker provider | Implemented | Container-backed provider implementation; `orchestrate` does not currently select it. |
| OpenShell provider | Implemented | Disposable clone, separate scratch data, validated Git bundle import, and sandbox teardown. See [guide](./docs/openshell-integration.md). |
| Context management | Implemented | Token-aware condensation summarizes older turns; message-count truncation remains the non-fatal fallback. See [`src/engine/condense.ts`](./src/engine/condense.ts). |

## Attribution

This project contains Apache-2.0-licensed code derived from
[Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code)
(`Zoo-Code-Org/Zoo-Code`, commit `ca9b60f`), itself a Roo Code fork. Prompt
text, tool schemas, and mode/rules loading logic are reused under the terms of
the Apache License 2.0. See [`licenses/Apache-2.0.txt`](./licenses/Apache-2.0.txt) and
[`ATTRIBUTION.md`](./ATTRIBUTION.md).

## License

HeadlessCode is licensed under Apache-2.0. See [LICENSE](LICENSE) and the Zoo Code attribution in [ATTRIBUTION.md](ATTRIBUTION.md). Previous public npm versions retain their published Apache-2.0 terms.
