# Phase 4 — Human-approval deploy gate

## 1. Why a human gate exists

`scripts/deploy-production.sh` in the target repo pushes to **production**:
by default it triggers the production GitHub Actions workflow of the target
project's deploy setup; with `--local` it builds/pushes images and deploys
directly to the target host. A fully automated pipeline must **never** reach
that script on its own — the deploy decision is a human decision, not an LLM
conclusion. The gate is therefore a **hard stop** between "everything passed"
and "deploy-production.sh runs":

```
workers done → review clean → QA pass → [HUMAN APPROVAL GATE] → deploy-production.sh
                                         ↑ never auto-approved
```

`--deploy` without approval **never** executes `deploy-production.sh` (verified
end-to-end in `scripts/e2e-phase4/run.sh`).

## 2. Gate design

The gate has three phases:

1. **Path safety** — the target repo and the deploy script path are resolved
   (`realpath -m`) and the script must live **inside** the target repo root.
   A path that escapes the repo (e.g. `--deploy-script ../../evil.sh`) is
   refused with exit 2 before anything else runs.
2. **Deployment summary** — what's being deployed is printed first, from (in
   priority order) a provided `--notes <file>`, or the
   `.worktrees/.orchestrator-state.json` batch summary (batch id + per-group
   status/review/QA), or a generic line.
3. **Approval** — two modes, both fail-closed:
   - **Interactive** (stdin is a TTY): `Approve deploy? [y/N]` — only an
     explicit `y`/`yes` approves; empty/anything else denies.
   - **Non-interactive** (token/file mode): exactly one of
     - a **one-time approval file** created by a human, e.g.
       `touch <repo>/.worktrees/.deploy-approved-<batch>` (or
       `$DEPLOY_APPROVAL_FILE`). Its mere existence is the human's explicit
       action — it does not exist until a human creates it; or
     - an env token `DEPLOY_APPROVAL_TOKEN` that **exactly matches** the token
       stored in `<repo>/.deploy-approval` (token file path overridable with
       `--token-file`).
   - Missing token, mismatched token, or nothing at all → **denied**.

Only after approval does the gate run the deploy script, passing deploy args
from `DEPLOY_ARGS` env / `--deploy-args` plus anything after `--`.

## 3. Where the decision logic lives

- [`src/deploy/gate.ts`](../src/deploy/gate.ts) — the **pure decision
  function** `decideApproval({ interactive, interactiveInput, approvalToken,
  tokenFileContent, approvalFileExists })` returns `{ approved, reason }`.
  It is fully unit-tested (`src/deploy/__tests__/gate.test.ts`) with no git /
  network / deploy script involved. `evaluateApproval` is the small I/O wrapper
  that reads the token/approval files then delegates to the pure function.
  `buildDeploySummary` produces the human-readable deployment summary.
- [`src/deploy/gate-cli.ts`](../src/deploy/gate-cli.ts) — a tiny CLI that the
  bash wrapper calls to make the decision (`node --import tsx
  src/deploy/gate-cli.ts ...`), printing `DEPLOY_SUMMARY_BEGIN/END`,
  `DEPLOY_APPROVED=yes|no` and `DEPLOY_REASON`. Exit code 0 = approved,
  3 = denied. Keeping the logic in TS is what makes it testable.
- [`scripts/deploy-gate.sh`](../scripts/deploy-gate.sh) — the thin bash
  wrapper: UI (interactive prompt), path safety, parsing the helper's output,
  and invoking the deploy script only when approved.

## 4. Security notes

- **Never auto-approve.** With no interactive input, no approval file, and no
  matching token, the answer is always denied — there is no code path that
  approves by default. The e2e asserts a wrong token → exit 3 + no marker.
- **Path safety.** The deploy script path is resolved with `realpath -m` and
  both the lexical path and the collapsed realpath must be strictly inside the
  target repo root; anything else exits 2 before any approval prompt or deploy
  action. Missing deploy script → clear error, exit 2, nothing runs.
- **Hard stop codes.** Exit 3 = human denied (the orchestrate round reports it
  and returns 1). The deploy script is invoked only on the line *after* the
  `DEPLOY_APPROVED=yes` branch.
- **Token hygiene.** The token is compared in-process (env vs file content);
  it is never logged. The gate prints reasons (which mention what was missing)
  but never the token values.
- The gate never runs a deploy script that the repo doesn't own — `DEPLOY_SCRIPT`
  defaults to `scripts/deploy-production.sh` and must resolve inside the repo.

## 5. Usage

Standalone:

```bash
# interactive (TTY):
bash scripts/deploy-gate.sh ~/Projects/my-target-repo --batch round-2026-08-01

# non-interactive, token mode:
printf 'my-secret-token\n' > ~/Projects/my-target-repo/.deploy-approval
DEPLOY_APPROVAL_TOKEN=my-secret-token \
  bash scripts/deploy-gate.sh ~/Projects/my-target-repo \
    --deploy-args "--local --deploy-only"

# non-interactive, one-time approval file (the human's explicit action):
touch ~/Projects/my-target-repo/.worktrees/.deploy-approved-round-2026-08-01
bash scripts/deploy-gate.sh ~/Projects/my-target-repo --batch round-2026-08-01
```

Env: `DEPLOY_APPROVAL_TOKEN`, `DEPLOY_APPROVAL_FILE`, `DEPLOY_ARGS`,
`DEPLOY_SCRIPT`. Exit codes: 0 approved+executed, 2 usage/path-safety error,
3 human DENIED (nothing ran).

## 6. Orchestrate `--deploy` flow

`headlesscode orchestrate --repo <path> --issue <n> ... --qa --deploy`:

1. Workers spawn, complete; each group is reviewed (clean) and QA'd (pass);
   both recorded in `.worktrees/.orchestrator-state.json` (`review_verdict`,
   `qa: { status, verdict, evidence, updated }`).
2. After the round, `deployGateReady` (in `src/orchestrator/cli.ts`) checks —
   fail-closed — that every group is `done`, none failed, every review is
   clean (when review is enabled) and every QA verdict is `pass` (when `--qa`
   was passed). A group that never passed QA (e.g. review found issues) blocks
   the deploy.
3. If ready, orchestrate invokes `scripts/deploy-gate.sh` (interactive when
   stdin is a TTY, token/file mode otherwise — inherited via `stdio: inherit`).
   `--deploy-args` / `DEPLOY_ARGS` are forwarded to the deploy script.
4. Denied (gate exit 3) → orchestrate prints "deploy DENIED … NOT run" and
   exits 1. Approved → the gate executes the repo's `deploy-production.sh`
   with the forwarded args.

Default behavior is unchanged without `--deploy`: no gate, no deploy.

## 7. Tests

- Unit: `src/deploy/__tests__/gate.test.ts` — `decideApproval` (token match /
  mismatch / missing file / missing env token / approval-file presence /
  interactive yes / anything-else / never auto-approve).
- E2E: `scripts/e2e-phase4/run.sh` sections 8-9 — wrong token → exit 3 + no
  marker; matching token → approved + fake deploy script invoked with forwarded
  args; one-time approval file → approved; escaping deploy-script path →
  exit 2; missing script → exit 2; and the full `orchestrate --deploy` wiring
  (approved round invokes the fake deploy; wrong token → exit 1, deploy NOT
  invoked).
