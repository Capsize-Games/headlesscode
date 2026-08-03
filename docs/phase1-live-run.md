# Phase 1 — Live real-issue run procedure

This document is the operator's manual for Phase 1 of the headless coding-agent
harness: running it against a **real GitHub issue**, unattended, with **zero VS
Code involvement**. It covers prerequisites, the isolated-worktree pattern, the
exact CLI invocation, configuration knobs (base URL, model, cost/time bounds),
exit-code semantics, the `--dry-run` validation flow, and how to judge the
result against the Zoo Code baseline.

> For the fully offline integration test (real CLI → real HTTP → local mock
> OpenRouter → isolated worktree of a fixture repo), run
> [`scripts/e2e/run.sh`](../scripts/e2e/run.sh) — no API key or network needed.
> This doc is about the real thing.

---

## 1. Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js ≥ 18 | The harness uses the native `fetch` API and `tsx` to run TS directly. |
| `npm install` (tsx, typescript) | Installs `tsx` (CLI runner) and `typescript` (type-checking). |
| Git ≥ 2.28 | Needed for `git worktree add -b` and the per-session branch pattern. |
| `HEADLESSCODE_OPENROUTER_API_KEY` | A valid OpenRouter API key (e.g. `sk-or-v1-...`). Required for every non-`--dry-run` invocation. |
| A target repo with issues | The repo you want the agent to work on — must already be cloned locally. |

Optional but recommended:

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_MODEL` | Model id (e.g. `deepseek/deepseek-v4-flash`). Defaults to `deepseek/deepseek-v4-flash` if unset; overridable per-run with `--model`. |
| `OPENROUTER_HTTP_REFERER` / `OPENROUTER_APP_TITLE` | Passed as `HTTP-Referer` / `X-Title` headers (OpenRouter rate-limit friendliness). |
| `OPENROUTER_BASE_URL` | Base URL override for testing/proxies — see §4. |

---

## 2. The isolated-worktree pattern (per session)

Phase 1's acceptance criteria require the harness to work **on a real issue in
an isolated worktree**, leaving the main checkout untouched. This mirrors the
project's proven `.worktrees/` approach (see the project plan: *"The worktree
isolation approach (`.worktrees/`, unique Docker ports/project names per
worktree) — proven, keep it"*).

Concretely, each session gets:

1. A throwaway branch created from the repo's current `HEAD`.
2. A fresh worktree checked out on that branch.
3. The harness run **inside that worktree**.
4. A human reviews the worktree diff and opens a PR — the main branch is never
   touched by the agent.

### Commands

```bash
# 1. Create the per-session worktree (mirrors scripts/e2e-fixture/spawn-worktree.sh)
git -C /path/to/repo worktree add -b fix/issue-29 /path/to/.worktrees/issue-29

# 2. Run the harness against the worktree (see §3 for the full invocation)
cd /path/to/headlesscode
HEADLESSCODE_OPENROUTER_API_KEY=sk-or-... npx tsx src/cli.ts \
  --task "<issue text, copied verbatim from GitHub>" \
  --mode code \
  --workspace /path/to/.worktrees/issue-29 \
  --max-iterations 50 \
  --log-file /tmp/headlesscode-issue-29.log

# 3. Review the result
git -C /path/to/repo worktree diff --stat issue-29   # or diff against main
git -C /path/to/.worktrees/issue-29 diff main         # from inside the worktree

# 4. When done, prune the worktree
git -C /path/to/repo worktree remove /path/to/.worktrees/issue-29
```

Notes:

- The same repo can host many simultaneous sessions: one worktree per issue,
  each on its own branch — exactly what Phase 2's spawner will automate.
- The fixture scripts under [`scripts/e2e-fixture/`](../scripts/e2e-fixture/)
  automate this for the integration test: `setup.sh` builds a throwaway fixture
  repo and `spawn-worktree.sh <repo> <path>` adds the isolated worktree.

---

## 3. The live run

### Step A — pick and scope an issue

Choose a real, already-scoped issue (the project plan cites e.g. #29 / #38 from
the existing backlog). The issue text becomes the `--task` argument verbatim —
the harness reads the task only from this string, so the issue should contain
everything the agent needs (or at least unambiguous pointers to the relevant
files).

### Step B — spin up the isolated worktree

See §2. For a one-off session:

```bash
git -C ~/Projects/<target-repo> worktree add -b fix/issue-N ~/Projects/<target-repo>/.worktrees/issue-N
```

### Step C — run the harness

```bash
cd /path/to/headlesscode

export HEADLESSCODE_OPENROUTER_API_KEY=sk-or-v1-...        # required
export OPENROUTER_MODEL=deepseek/deepseek-v4-flash # optional (default model)

npx tsx src/cli.ts \
  --task "<issue #N: the full issue text>" \
  --mode code \
  --workspace ~/Projects/<target-repo>/.worktrees/issue-N \
  --max-iterations 50 \
  --log-file /tmp/headlesscode-issue-N.log
```

Expected behavior:

- The agent reads the relevant files (`read_file`), edits them
  (`write_to_file`), runs commands to verify (`execute_command`), lists
  directories as needed (`list_files`), and finally emits `attempt_completion`
  with a summary.
- Everything logs to stdout and to `--log-file`; there are no approval
  prompts, no webview, no VS Code anywhere.
- On success the completion summary is printed to stdout and the process exits
  `0`.

### Step D — review the worktree diff / open the PR

```bash
git -C ~/Projects/<target-repo>/ worktree diff --stat
git -C ~/Projects/<target-repo>/ worktree diff    # full diff, or diff against main
```

Review the diff exactly as you would a colleague's PR (fresh-context review is
a core principle of this project — see §7). If it's good, push the worktree's
branch and open a PR. Then remove the worktree.

---

## 4. Configuration reference

### `OPENROUTER_BASE_URL` (testing/proxies)

The client posts to `{OPENROUTER_BASE_URL}/api/v1/chat/completions`. The
default is `https://openrouter.ai`; override the whole base with this env var.
This is how the offline integration test points the real client at
[`scripts/e2e/mock-openrouter.mjs`](../scripts/e2e/mock-openrouter.mjs):

```bash
OPENROUTER_BASE_URL=http://127.0.0.1:44193 \
HEADLESSCODE_OPENROUTER_API_KEY=test-key \
npx tsx src/cli.ts --task "fix the greet function" --workspace <worktree>
```

It also enables routing through a proxy or a self-hosted gateway. The
per-request `baseUrl` option on `OpenRouterClient` still wins over the env var,
and the env var wins over the built-in default.

### Model

- `--model <id>` (CLI flag) → `OPENROUTER_MODEL` env var → `deepseek/deepseek-v4-flash`.
- Resolution happens per request: request model → client default → env → built-in.

### Cost / time bounds

| Knob | Default | Meaning |
| --- | --- | --- |
| `--max-iterations <n>` | `50` | Hard cap on loop iterations. Each iteration is one LLM call plus its tool executions. A real issue typically needs 3–15. |
| `--consecutive-error-limit <n>` | `3` | Consecutive tool errors / parse failures / identical repeated calls / empty replies before the session is aborted as a bounded failure. |
| Per-LLM-call timeout | `120 s` | Each chat-completions call is aborted after 120s (loop constant `DEFAULT_LLM_TIMEOUT_MS`). A timeout aborts the whole session. |
| `execute_command` timeout | `120 s` per command | Commands are killed (`SIGKILL`) past this; the kill is reported as a tool error. |

A conservative live configuration: `--max-iterations 25` keeps the worst-case
cost bounded while leaving plenty of headroom; monitor `--log-file` for the
iteration/tool progress.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success — `attempt_completion` (or a text-only final answer) was received; the result is on stdout. |
| `1` | Task failed — max iterations reached, consecutive-mistake bound tripped, or an LLM call failed/timed out. Details in stderr and the log. |
| `2` | Usage / configuration error — bad arguments, missing `HEADLESSCODE_OPENROUTER_API_KEY` (unless `--dry-run`), empty task, unreadable `--task-file`, etc. |

### `--dry-run` (validation without an API key)

```bash
npx tsx src/cli.ts --dry-run --mode code --workspace <worktree>
npx tsx src/cli.ts --dry-run --mode issue-fixer --workspace <worktree>   # custom mode
```

Builds the system prompt, loads `.roomodes`, splices
`.roo/rules-<mode>/`, `.roo/rules/`, and `AGENTS.md`, selects the tool set for
the mode, prints the prompt plus a summary (`mode`, `workspace`, custom modes,
exposed tools, prompt size), and exits `0` — **without calling the LLM**. Use
it to sanity-check a repo's rules/modes and which tools a mode exposes. The
integration test runs exactly this check before the real harness run.

---

## 5. What the harness reads from the target repo

- `.roomodes` — custom modes (same YAML/JSON + zod schema Zoo Code uses).
- `.roo/rules-<mode>/` — mode-specific rules for the selected mode slug.
- `.roo/rules/` — generic rules.
- `AGENTS.md` — agent rules (also `AGENT.md`, and `AGENTS.local.md` is honored
  if present).
- The working tree itself, via `read_file` / `write_to_file` /
  `execute_command` / `list_files` — all constrained to the workspace root
  (path-traversal guard).

No `vscode.*` anywhere; the vendored prompt builder is driven through a
headless shim (see [`src/engine/prompt.ts`](../src/engine/prompt.ts)).

---

## 6. Comparison checklist vs the Zoo Code baseline

Per the Phase 1 success criterion ("real, useful, comparable-quality work on a
real issue, unattended, with no VS Code involved"), evaluate each live run
against the Zoo Code/DeepSeek results from earlier rounds:

- [ ] Same tools used (read → edit → run command → complete), same
      OpenAI-function-calling schema.
- [ ] Same system prompt and mode/rules configuration (the harness reuses the
      vendored prompt builder, `getNativeTools`, `getToolsForMode`,
      `.roomodes`, `.roo/rules-*`, `AGENTS.md`).
- [ ] Final diff quality is comparable — correct files touched, minimal
      changes, no out-of-scope edits, tests/verification command actually run.
- [ ] Zero VS Code involvement — no editor, no webview, no approval prompts;
      ran unattended to completion or a bounded failure.
- [ ] Worktree isolation held — main checkout untouched, one branch per issue.
- [ ] Logs make the session auditable (each tool call + result + iterations).

Known Phase 1 gaps vs Zoo Code (acceptable, tracked for later phases):
`apply_diff`/`search_replace`/`edit_file` are not implemented yet (only
`read_file`, `write_to_file`, `execute_command`, `list_files`), history
truncation is a placeholder sliding window rather than token-based
condensation, and there is no MCP support.

---

## 7. Next steps (Phase 2+)

- **Phase 2 — orchestration swap**: replace the
  `scripts/spawn-parallel-worktrees.sh` "open VS Code + xdotool-inject" step
  with "spawn a background process running this harness" — the worktree/Docker
  isolation infrastructure carries over unchanged. Reuse the existing
  review-mode checklist as a headless "reviewer" invocation, and the existing
  issue-splitting heuristics as-is.
- **Phase 3 — memory system**: a UwUChat-facing knowledge/recall API (facts
  about the codebase, rolling session summaries, local embeddings), explicitly
  gated on several real Phase 1/2 sessions.
- **Phase 4 — QA/deploy**: evaluate the existing `qa-agent` (Playwright MCP)
  and `scripts/deploy-production.sh` for headless invocation.
- **Phase 5 — issue watcher**: a poll/webhook loop that detects newly-labeled
  issues and spawns sessions automatically, with durable in-progress tracking.
- **Phase 6 — cloud scaling**: port the worktree + isolated-container pattern
  to ephemeral compute, with hard concurrency and per-session cost caps.

The end-to-end integration harness in [`scripts/e2e/`](../scripts/e2e/) is the
regression net that must keep passing as all of this lands.
