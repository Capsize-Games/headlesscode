# headlesscode

A small, purpose-built, genuinely headless coding-agent harness. It reuses what
makes [Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code) (an Apache-2.0 Roo
Code fork) good — its system prompts, native tool schemas, and
mode/rules configuration format — without carrying along the VS Code GUI
dependency.

This repo implements:

- The **headless runtime engine** — vendoring the portable Apache-2.0 core and
  the headless runtime (OpenRouter client, tool executor, tool-call parser,
  orchestration loop, CLI).
- A **headless orchestration layer** — split an issue into worker groups, run
  each as a harness subprocess in its own git worktree, review, and merge
  (see [`docs/phase2-orchestration.md`](./docs/phase2-orchestration.md)).
- A **memory subsystem** — per-project knowledge facts + rolling session
  summaries, with local semantic recall and a pluggable `MemoryStore`
  contract for a remote backend.
- **Headless QA** — run the target repo's `qa-agent` mode as a second harness
  session (see [`docs/phase4-qa.md`](./docs/phase4-qa.md)) and a
  human-approval deploy gate in front of the repo's `deploy-production.sh`
  (see [`docs/phase4-deploy-gate.md`](./docs/phase4-deploy-gate.md)).
- A **GitHub issue watcher** (see
  [`docs/phase5-issue-watcher.md`](./docs/phase5-issue-watcher.md)) — file an
  issue with a target label and a poll loop automatically splits and spawns it
  through the existing orchestration pipeline, with durable idempotency so a
  restart never double-spawns.
- **Cloud-scaling guardrails** — a hard concurrent-session cap, a per-session
  cost/time/iteration budget, and a `CloudProvider` abstraction (container/VM
  per issue behind the same lifecycle as the local worktree flow) with an
  evaluation-only cloud-provider sketch (see
  [`docs/phase6-cloud.md`](./docs/phase6-cloud.md)). No live cloud resources
  are launched; the caps/budgets land before any scaling.

> ⚠️ **Security warning: default-allow arbitrary command execution.**
> `headlesscode` is a headless coding agent: by default it runs **arbitrary
> shell commands with your full user privileges** (no sandbox, no approval
> prompts) and can read and modify your files — including `~/.ssh`, `~/.aws`,
> and any other credentials your user can access. Run it only on machines and
> with tasks you trust, and isolate it (container/VM/dedicated user) whenever
> untrusted content is involved. See [`SECURITY.md`](./SECURITY.md) for the
> full disclosure and the optional permissions layer that provides defense in
> depth (not a security boundary).

## Purpose

Drive a coding agent headlessly against real git repos: read a target repo's
`.roomodes` and `.roo/rules-<slug>/` files, build a system prompt from mode +
rules, call an LLM API (OpenRouter in Phase 1) with the tool schema, execute
tool calls via plain `fs`/`child_process` (no `vscode.*` anywhere), and loop
until completion. Non-interactive by design.

## Quick start

`headlesscode` is not yet published to the npm registry, so install it from a
checkout:

```bash
git clone https://github.com/Capsize-Games/headlesscode.git
cd headlesscode
npm install

# Required (except for --dry-run):
export HEADLESSCODE_OPENROUTER_API_KEY=sk-or-...

# Optional:
export OPENROUTER_MODEL=deepseek/deepseek-v4-flash-0731  # default model
export OPENROUTER_HTTP_REFERER=https://example.com       # OpenRouter app header
export OPENROUTER_APP_TITLE="headlesscode"               # OpenRouter X-Title header
export HEADLESSCODE_WORKSPACE_ROOT=/path/to/target/repo  # default workspace root

# Run a task against a target repo, straight from the checkout:
node bin/headlesscode.mjs --task "Fix the bug in src/index.ts" --workspace /path/to/target/repo
```

### Systemwide `headlesscode` command

To avoid re-typing `node <checkout>/bin/headlesscode.mjs` from every project,
install a `headlesscode` command onto your `PATH` once:

```bash
scripts/install-cli.sh
```

This writes a wrapper to `~/.local/bin/headlesscode` (override with
`HEADLESSCODE_BIN_DIR`) that runs this checkout's `src/cli.ts` via its local
`tsx`, without `cd`-ing — so `--repo`/`--workspace` still default to whatever
directory you're standing in when you invoke it. Re-run the script any time
after `git pull` to point it at a moved checkout; the wrapper itself doesn't
need updating for ordinary code changes.

```bash
# from any repo, no HEADLESSCODE_ROOT plumbing needed:
headlesscode orchestrate --repo . --issue 42
```

The rest of this README uses the plain `headlesscode` form for brevity —
substitute `node <checkout>/bin/headlesscode.mjs` if you haven't run
`scripts/install-cli.sh` yet.

## The `--dry-run` flow (no API key needed)

`--dry-run` builds the full system prompt and validates configuration loading
without calling the LLM — useful for CI and for checking that a target repo's
`.roomodes` / `.roo/rules-<slug>/` / `AGENTS.md` are picked up:

```bash
headlesscode --dry-run --mode code --workspace /path/to/target/repo
```

It prints the assembled system prompt plus a summary line (mode, custom modes
loaded, exposed tools, prompt size). Exit code 0 means prompt building + mode /
rules loading succeeded; non-zero means a config error.

## Real-usage example against a target repo

```bash
export HEADLESSCODE_OPENROUTER_API_KEY=sk-or-...
export HEADLESSCODE_WORKSPACE_ROOT=~/Projects/some-target-repo

# Point the agent at an already-scoped issue, in an isolated worktree:
headlesscode \
  --mode code \
  --task "Implement issue #29: add retry logic to the HTTP client (see .roo/rules for project conventions)." \
  --workspace ~/Projects/some-target-repo \
  --max-iterations 50 \
  --log-file ./headlesscode-session.log
```

The agent reads files, runs commands, writes code, and finishes by calling
`attempt_completion` (or by giving a final text answer). The final result is
printed to stdout. Exit code 0 = success; 1 = task failed (max iterations or
consecutive-mistake limit); 2 = usage/config error (e.g. missing
`HEADLESSCODE_OPENROUTER_API_KEY`).

## Registering a new project

To use headlesscode against a project that isn't set up as a headlesscode
project yet, register it in one step:

```bash
headlesscode init --workspace ~/Projects/your-project
```

This detects the project's stack(s) (which drives per-session instruction
selection), makes sure the project's `.gitignore` excludes `.headlesscode/`
session artifacts, and builds the codebase-search index and the codemap — no
manual `index`/`codemap`/`.gitignore` steps needed. The index step calls the
embedding API and costs real money unless you pass `--skip-index` or
`--embedding-backend ollama`. See `headlesscode init --help` for the full
options.

## CLI reference

```
headlesscode --task "<task text>" [options]
headlesscode --task-file <path> [options]
headlesscode --dry-run [options]
headlesscode orchestrate --repo <path> --issue <n> [--issue <n> ...] [options]
headlesscode watch --owner <o> --repo <path> --label <name> [options]

  --mode <slug>                 Mode to run in (built-in or from .roomodes). Default: code
  --task <text>                 The task description for the agent
  --task-file <path>            Read the task from a file (relative to workspace)
  --workspace <root>            Workspace root (default: $HEADLESSCODE_WORKSPACE_ROOT or cwd)
  --model <id>                  OpenRouter model id (default: $OPENROUTER_MODEL or deepseek/deepseek-v4-flash-0731)
  --max-iterations <n>          Loop iteration cap (default: 50)
  --consecutive-error-limit <n> Consecutive mistakes before giving up (default: 3)
  --max-cost-usd <n>            Phase 6: per-session cost cap in USD (decimal). Default
                                $HEADLESSCODE_MAX_COST_USD; off when neither is set
  --max-duration-ms <n>         Phase 6: per-session wall-clock cap in ms. Default
                                $HEADLESSCODE_MAX_DURATION_MS; off when neither is set.
                                A tripped cap aborts with reason "budget"
  --log-file <path>             Also append structured logs to this file
  --memory-dir <path>           Phase 3 memory: store facts + session summaries under <path>
                                (enabled; default $HEADLESSCODE_MEMORY_DIR or
                                <workspace>/.headlesscode/memory). Memory is OFF unless set.
  --no-memory                   Explicitly disable memory even if HEADLESSCODE_MEMORY_DIR is set
  --allowed-commands <list>  Comma-separated command prefixes the agent may run.
                               Default: $HEADLESSCODE_ALLOWED_COMMANDS, else
                               .headlesscode/permissions.json, else empty (=
                               allow everything except --denied-commands; see
                               SECURITY.md)
  --denied-commands <list>   Comma-separated command prefixes that are ALWAYS
                               refused (deny wins over allow; dangerous shell
                               substitutions are always blocked regardless).
                               Default: $HEADLESSCODE_DENIED_COMMANDS, else
                               .headlesscode/permissions.json, else empty
  --protected-files <list>   Comma-separated glob patterns of files the agent may
                               not write. Default: $HEADLESSCODE_PROTECTED_FILES,
                               else .headlesscode/permissions.json, else
                               ".env,.env.*,*.pem,*.key,id_rsa*"
  --allow-protected-writes   Escape hatch: permit writes to protected files
                               (default: OFF). Also settable via
                               "allowProtectedWrites": true in
                               .headlesscode/permissions.json
  --dry-run                     Build the system prompt + validate config, then exit (no API key)
  --version / --help

orchestrate subcommand (Phase 2 — parallel worktrees, headless workers):
  --repo <path>                 Target repo root (required)
  --issue <n>                   Issue number to include (repeatable)
  --issues-json <file>          Read issues from a JSON array of {number,title,body}
                                (used when gh is unavailable, or for tests)
  --file-issues                 With --issues-json: file a REAL GitHub issue for
                                each synthetic entry (gh issue create --repo
                                <origin-owner>/<origin-repo>), swap in the real
                                number returned, and print one confirmation line
                                per created issue. A real, visible write to
                                GitHub — opt-in, never automatic. Requires
                                --issues-json
  --batch <name>                Batch id in the state file (default round-<date>)
  --review-mode <slug>          Mode slug for review sessions (default deepseek-reviewer)
  --no-review                   Spawn + watch only; skip the reviewer
  --qa                         Phase 4: run a headless QA session (--mode qa-agent)
                                on each group after its review passes; record
                                qa {status,verdict,evidence} in the state file
  --qa-mode <slug>              Mode slug for QA sessions (default qa-agent; the
                                target repo's .roomodes + .roo/rules-<slug>/ are
                                spliced automatically)
  --deploy                      Phase 4: after all groups done + reviewed + QA passed,
                                run the human-approval deploy gate
                                (scripts/deploy-gate.sh) — a hard stop that never runs
                                the repo's deploy-production.sh without explicit human
                                approval (interactive on a TTY, token/file otherwise)
  --deploy-args <str>           Deploy args forwarded to the deploy script after the
                                gate approves (space-separated flags; also DEPLOY_ARGS env)
  --poll-interval-ms <n>        Watcher poll interval (default 5000)
  --max-concurrent-sessions <n> Phase 6 global cap on concurrent sessions across
                                processes (default $HEADLESSCODE_MAX_CONCURRENT_
                                SESSIONS or 3). At/over the cap this run ABORTS
                                with a clear message, exit 1
  --dry-run                     Print the split plan + spawn commands, spawn nothing

watch subcommand (Phase 5 — GitHub issue watcher, poll-based intake):
  --owner <o>                   GitHub owner (required)
  --repo <path>                 Local clone of the target repo (required; worktrees
                                are spawned under <path>/.worktrees/). The GitHub repo
                                name defaults to the directory basename (--gh-repo overrides)
  --label <name>                The label that triggers processing, e.g. needs-agent
  --poll-interval-ms <n>        Sweep interval in continuous mode (default 60000)
  --run-once                    One sweep then exit 0 (or 1 if any spawn failed)
  --max-per-sweep <n>           Max NEW issues spawned per sweep (default 5); the rest
                                stay 'pending' in state and are picked up next sweep
  --max-concurrent-sessions <n> Phase 6 GLOBAL cap on concurrent sessions across
                                processes (default $HEADLESSCODE_MAX_CONCURRENT_
                                SESSIONS or 3). Interplay: maxPerSweep bounds one
                                sweep's burst; this bounds the total fleet — issues
                                beyond it stay 'pending' until slots free up
  --state-file <path>           Durable idempotency state (default
                                <repo>/.worktrees/.watcher-state.json)
  --mode <slug> / --memory-dir <path>
                                Forwarded to the spawner (ORCHESTRATOR_MODE /
                                HEADLESSCODE_MEMORY_DIR)
  --qa / --deploy               Pass-through: recorded per batch for the follow-up
                                orchestrate completion run
  --dry-run                     Sweep + print the spawn plan, spawn nothing, write no
                                state (still needs a GitHub token for listIssues)
  --retry-failed                Retry previously-failed spawns next sweep
```

## Architecture

- [`src/llm/openrouter.ts`](./src/llm/openrouter.ts) — OpenRouter
  chat-completions client using native `fetch` (no axios/node-fetch/openai
  SDK). Reads `HEADLESSCODE_OPENROUTER_API_KEY`, optional `OPENROUTER_HTTP_REFERER` /
  `OPENROUTER_APP_TITLE`; model default `deepseek/deepseek-v4-flash-0731` (env
  `OPENROUTER_MODEL` overrides). Non-2xx → typed `OpenRouterError` with status +
  body excerpt; supports `AbortSignal` timeouts.
- [`src/tools/executor.ts`](./src/tools/executor.ts) — headless executor for
  `read_file`, `write_to_file`, `execute_command`, `list_files` (plain
  `fs`/`child_process`), plus `attempt_completion` / `ask_followup_question`
  handlers and "not implemented" stubs for every other vendored tool schema.
  All file operations are resolved relative to the workspace root and rejected
  if they escape it (path-traversal guard via `path.resolve` + containment
  check). Command results are truncated (~30k chars) to keep context bounded.
- [`src/tools/output-summarizer.ts`](./src/tools/output-summarizer.ts) —
  OPT-IN local summarization of oversized `execute_command` output: when
  `HEADLESSCODE_LOCAL_SUMMARIZATION=1`, a result that would exceed the 30k
  char cap is compressed by a local Ollama chat model before reaching the
  cloud model, with a `[Output summarized by local model…]` transparency
  header. OFF by default; on any failure it falls back to today's exact blunt
  truncation (never an error, never a hang). Endpoint/model configurable via
  `HEADLESSCODE_OLLAMA_URL` (default `http://localhost:11434`) and
  `HEADLESSCODE_SUMMARIZATION_MODEL` (default `qwen3:8b`). Deliberately
  limited to command output — file/diff content always stays verbatim.
- [`src/engine/parser.ts`](./src/engine/parser.ts) — OpenAI function-calling
  parser: JSON.parses `tool_calls[].function.arguments` with a best-effort
  partial-JSON fallback; parse failures are marked and fed back as errors.
- [`src/engine/prompt.ts`](./src/engine/prompt.ts) — wraps the vendored
  `SYSTEM_PROMPT` builder: loads project `.roomodes` (same zod schema as Zoo
  Code's `CustomModesManager`), passes the workspace as `cwd` so `.roo/rules-*`
  / `AGENTS.md` splice in, and selects the mode's exposed tools.
- [`src/engine/loop.ts`](./src/engine/loop.ts) — `HeadlessSession`, the
  orchestration loop. System + user → LLM → assistant (with tool_calls) → parse
  → execute → `tool` role message → repeat. Terminates on `attempt_completion`
  (its `args.result` is the final answer) or a text-only reply; fails bounded
  on max iterations or `consecutiveErrorLimit` consecutive mistakes (tool
  errors / parse errors / identical repeated calls). History truncation is a
  Phase 1 placeholder: system + first user always kept, sliding window of the
  last ~40 messages. The loop accepts an injected `llmClient` (DI) so tests use
  a fake; the CLI wires `OpenRouterClient`.
- [`src/engine/logger.ts`](./src/engine/logger.ts) — structured logger
  (timestamped lines to stdout/stderr, optional file).
- [`src/memory/`](./src/memory/index.ts) — memory subsystem:
  - [`src/memory/types.ts`](./src/memory/types.ts) — the `MemoryFact` /
    `SessionSummary` schema (per-project scoped, kinds
    `convention|decision|failure|knowledge` where "things that didn't work"
    are `failure`) and the two contracts: `MemoryStore` (the pluggable
    storage boundary) and `Embedder`. Hard data-isolation requirement
    documented: the harness knowledge is a dedicated schema, never reachable
    through any customer tenant route.
  - [`src/memory/local.ts`](./src/memory/local.ts) — `LocalMemoryStore`: the
    fully working file backend (`facts/<project>.jsonl` +
    `sessions/<project>.jsonl`, append-only, idempotent `addFact` by content
    hash, `queryRecall` = keyword matches (high weight) + local-embedder
    cosine similarity, deterministic ordering).
  - [`src/memory/embed.ts`](./src/memory/embed.ts) — `createLocalEmbedder()`:
    zero-dependency, deterministic lexical-hash embedder (lowercase word +
    char-bigram tokens → fixed-dim L2-normalized vector). Placeholder for a
    real local embedding model behind the same `Embedder` interface.
  - [`src/memory/summarizer.ts`](./src/memory/summarizer.ts) —
    `extractSessionSummary` (deterministic; files/commands derived from the
    tool history, facts via keyword heuristics) + `buildRollingSummary`
    (compact markdown recap of the last N sessions, so a session never needs
    the infinite raw history).
  - [`src/memory/uwuchat.ts`](./src/memory/uwuchat.ts) — a remote
    `MemoryStore` implementation stub for a future hosted memory API. Throws
    "not implemented" until its base-URL/token env vars are set.
  - Memory is wired into `HeadlessSession` as an **opt-in** config (`memory`
    + `project`); when unset the loop behaves exactly as before. When set, the
    loop injects a `## PROJECT MEMORY` section (recalled facts + rolling
    recap) into the first user message and records the session + extracted
    facts afterwards — and memory failures are always non-fatal.
- [`src/orchestrator/`](./src/orchestrator/index.ts) — Phase 2 orchestration
  layer: `split.ts` (issue-splitting heuristics, deterministic +
  unit-tested), `state.ts` (`.worktrees/.orchestrator-state.json` read/write),
  `reviewer.ts` (adversarial fresh-context review run with a read-only
  executor), `watch.ts` (completion polling of `.harness.done` markers + stall
  guard), and `cli.ts` (the `orchestrate` subcommand — split → spawn via
  `scripts/spawn-parallel-worktrees.sh` → watch → review → QA → deploy gate).
- [`src/qa/qa.ts`](./src/qa/qa.ts) — Phase 4 headless QA: `runQa()` runs a
  second harness session against a worktree in the target repo's `qa-agent`
  mode (auto-spliced from `.roomodes` + `.roo/rules-qa-agent/`), with a
  generic checklist fallback when the repo has no such mode. Read + command
  tools only (no `write_to_file`) — QA verifies and reports, it never edits.
  Verdict parsing is fail-closed (`pass`/`fail`/`error`, default `fail`).
- [`src/deploy/gate.ts`](./src/deploy/gate.ts) + [`src/deploy/gate-cli.ts`](./src/deploy/gate-cli.ts) —
  Phase 4 human-approval deploy gate: the pure, unit-tested decision function
  `decideApproval` (interactive y/N, one-time approval file, or
  `DEPLOY_APPROVAL_TOKEN` matching `<repo>/.deploy-approval`; never
  auto-approves) plus a thin CLI the bash wrapper calls.
- [`src/watcher/`](./src/watcher/index.ts) — Phase 5 GitHub issue watcher:
	[`github.ts`](./src/watcher/github.ts) (native-fetch GitHub REST client with
	label filter, PR filtering, pagination, `GITHUB_API_BASE_URL` override for
	tests/mocks), [`state.ts`](./src/watcher/state.ts) (durable idempotency
	state file — write-ahead `spawned` → `done`/`failed`, `pending` for capped
	issues, restart-safe), [`watch.ts`](./src/watcher/watch.ts) (the poll loop:
	list by label → split → spawn via the existing bash spawner, bounded by
	`maxPerSweep` and the Phase 6 global cap), and [`cli.ts`](./src/watcher/cli.ts)
	(the `watch` subcommand — continuous or `--run-once`, `--dry-run`,
	`--retry-failed`).
- [`src/budget/`](./src/budget/index.ts) — Phase 6 guardrails:
	[`cost.ts`](./src/budget/cost.ts) (model pricing table + `estimateCost`,
	`HEADLESSCODE_PRICING_JSON` override, conservative fallback for unlisted
	models), [`budget.ts`](./src/budget/budget.ts) (`SessionBudget` +
	`BudgetTracker`: `tick()` before each LLM call, `record()` after with usage
	tokens, `check()` snapshot, `BudgetExceededError`), and
	[`concurrency.ts`](./src/budget/concurrency.ts) (`ConcurrencyLimiter` —
	fail-fast in-process semaphore — plus `activeSessionCount` reading the
	durable orchestrator/watcher state files for a cross-process view). Wired
	into `HeadlessSession` (`budget` config, `budgetUsage` on results), the base
	CLI (`--max-cost-usd` / `--max-duration-ms`), `orchestrate` (aborts at the
	cap), the watcher (defers cap-exceeding issues to `pending`), and
	`run-worker.sh`/`run-qa.sh` (env forwarding).
- [`src/cloud/`](./src/cloud/provider.ts) — Phase 6 ephemeral compute
	abstraction: the `CloudProvider` lifecycle interface
	(`spawnWorktreeSession` → `waitReady` → `runHarness` → `collectResults` →
	`teardown`) with `LocalProcessProvider` as the current local behavior behind
	it (reuses `spawn-parallel-worktrees.sh` + `run-worker.sh`), so a
	container/VM-per-issue backend slots in without touching the orchestration
	layer. A cloud-provider sketch is documented (evaluation only — no
	live setup; see [`docs/phase6-cloud.md`](./docs/phase6-cloud.md)).
- [`src/cli.ts`](./src/cli.ts) — the `headlesscode` bin entry (+ `orchestrate`
  and `watch` subcommand dispatch).
- [`scripts/run-worker.sh`](./scripts/run-worker.sh) — launches one headless
  harness worker per worktree (pid, log, exit code, `.harness.done` marker).
- [`scripts/run-qa.sh`](./scripts/run-qa.sh) — Phase 4 QA wrapper mirroring
  run-worker.sh: launches one harness QA session per worktree (`.qa-task.md`,
  `.qa.pid`, `qa.log`, `.qa.exit`, `.qa.done/`).
- [`scripts/deploy-gate.sh`](./scripts/deploy-gate.sh) — Phase 4 gate wrapper:
  path safety, deployment summary, interactive + token/file approval, then
  (and only then) invokes the repo's `scripts/deploy-production.sh` with
  forwarded deploy args. Exit 3 = human DENIED (hard stop).
- [`scripts/spawn-parallel-worktrees.sh`](./scripts/spawn-parallel-worktrees.sh)
  — spawns one git worktree + harness worker per group (worktree/.env/branch
  conventions, `run-worker.sh` + state-file writes, no GUI involved).

### Phase 1 tool filtering decision

The loop exposes to the model exactly the tools the executor can actually run
for the selected mode: the intersection of the vendored mode tool groups
(`getToolsForMode`) with the Phase 1 executable set
(`read_file`, `write_to_file`, `execute_command`, `list_files`,
`attempt_completion`, `ask_followup_question`). Stub-only tools (`apply_diff`,
`search_files`, …) stay registered in the executor purely as a safety net
(clear "not implemented" error) but are NOT advertised to the model, so it
doesn't waste turns calling them.

## Development

```bash
npm run typecheck     # npx tsc --noEmit (whole repo incl. vendored core)
npm run smoke         # vendored prompt builder smoke test (no network)
npm test              # unit tests with fake LLM clients (no network/key)
bash scripts/e2e/run.sh            # Phase 1 integration (mock OpenRouter)
bash scripts/e2e-phase2/run.sh     # Phase 2 integration (spawn + watch + review)
bash scripts/e2e-phase4/run.sh     # Phase 4 integration (QA + deploy gate, fake deploy)
bash scripts/e2e-phase5/run.sh     # Phase 5 integration (watcher vs fake GitHub server,
                                   #   stubbed spawner: state transitions + no double-spawn)
bash scripts/e2e-phase6/run.sh     # Phase 6 integration (budget abort via mock OpenRouter
                                   #   + concurrency-cap sweep via fake GitHub + stubbed spawner)
npm run cli -- --dry-run --workspace .   # build this repo's system prompt
```

The engine tests (`src/engine/__tests__/loop.test.ts`) run the full loop with a
fake `LlmClient` injected via the `HeadlessSession` constructor — no network,
no API key required. Phase 2 adds `src/orchestrator/__tests__/` (split
heuristics, state round-trip, reviewer verdict parsing), and the e2e scripts
drive the real CLI through a local mock OpenRouter server, including a
2-worktree parallel spawn, completion-marker polling, and a read-only review
invocation. Phase 5 adds `src/watcher/__tests__/` (github client with an
injected fetch, watcher-state idempotency semantics, and the watch loop with
an injected gh client + spawner covering spawn/idempotency/cap/failure/
dry-run/abort) and `scripts/e2e-phase5/run.sh` (watcher against a fake GitHub
server with a stubbed spawner).

## Phase status

- ✅ Phase 1 Subtask 1 — vendored portable Zoo Code core
  ([`src/vendor/zoo-code/`](./src/vendor/zoo-code/), read-only dependency).
- ✅ Phase 1 Subtask 2 — runtime engine (OpenRouter client, tool executor,
  parser, orchestration loop, CLI, tests).
- ✅ Phase 2 — headless orchestration layer: drop-in
  `spawn-parallel-worktrees.sh` + `run-worker.sh` (harness subprocess per
  worktree, `.harness.done` completion markers), issue-splitting heuristics
  port, `.orchestrator-state.json` state management, headless reviewer, and
  the `orchestrate` CLI subcommand (see
  [`docs/phase2-orchestration.md`](./docs/phase2-orchestration.md)).
- ✅ Phase 3 — memory subsystem: per-project knowledge facts + rolling session
  summaries (`src/memory/`), local deterministic embedder for semantic recall,
  opt-in `HeadlessSession`/CLI wiring (`--memory-dir`, `--no-memory`), and a
  pluggable `MemoryStore` contract with a remote-backend client stub.
- ✅ Phase 4 — QA + deploy gate: headless QA runs the target repo's `qa-agent`
  mode (`--qa` / `--qa-mode`), verdict parsing is fail-closed, results land in
  the state file's per-group `qa` field; the human-approval deploy gate
  (`--deploy`, `scripts/deploy-gate.sh` + `src/deploy/gate.ts`) is a hard stop
  in front of `deploy-production.sh` that never auto-approves (see
  [`docs/phase4-qa.md`](./docs/phase4-qa.md) and
  [`docs/phase4-deploy-gate.md`](./docs/phase4-deploy-gate.md)).
- ✅ Phase 5 — GitHub issue watcher: poll-based intake (`watch` subcommand) —
  detect issues by label via the GitHub REST API (`GH_TOKEN`), fan each out
  through `splitIssues` + the existing `spawn-parallel-worktrees.sh`, track
  idempotency durably (`.worktrees/.watcher-state.json`, write-ahead
  ordering, `pending` cap deferral, restart-safe), optional `--dry-run` /
  `--run-once` / `--retry-failed`; webhook upgrade designed but not built as
  a server (see [`docs/phase5-issue-watcher.md`](./docs/phase5-issue-watcher.md)).
- ✅ Phase 6 — cloud scaling, guardrails-first: per-session cost/time/iteration
  budget (`src/budget/`, `--max-cost-usd` / `--max-duration-ms`, budgetUsage on
  results, worker env forwarding) + a hard concurrent-session cap
  (`HEADLESSCODE_MAX_CONCURRENT_SESSIONS`, orchestrate aborts / watcher defers
  to `pending`) + the `CloudProvider` abstraction with `LocalProcessProvider`
  and an evaluation-only cloud-provider sketch (see
  [`docs/phase6-cloud.md`](./docs/phase6-cloud.md)). No live cloud launched;
  a container/VM-per-issue backend slots in behind the same interface.
- ⏳ Phase 3 (remaining) — token-based condensation.

## Attribution

This project contains Apache-2.0-licensed code derived from
[Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code)
(`Zoo-Code-Org/Zoo-Code`, commit `ca9b60f`), itself a Roo Code fork. Prompt
text, tool schemas, and mode/rules loading logic are reused under the terms of
the Apache License 2.0. See [`LICENSE`](./LICENSE) and
[`ATTRIBUTION.md`](./ATTRIBUTION.md).
