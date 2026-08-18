Project and mode-specific rules (from the central shared store and this project's own
.roo/rules*) are already spliced into your system prompt automatically — you do not
need to read any rules file yourself.

You are working autonomously in the SAME isolated git worktree as the previous attempt, on
the same branch. The automated adversarial reviewer found problems with that attempt. Read
this entire file before doing anything.

## Rework cycle 2 — address the review findings

Assigned issues: #64, #99. The real title/body of each is inline below.

### Issue #64: SEC-3 [security][HIGH] Symlink escape defeats workspace containment

## Severity
HIGH

## Audit area
security

## Location
`src/tools/executor.ts:353` — resolveWithinWorkspace is lexical-only, documented "no symlink-following resolution"; all fsp calls in file tools follow symlinks.

## Description
An agent can `ln -s ~/.ssh <ws>/sshlink` then read_file/write_to_file/apply_diff through it — read AND write outside the workspace; the protected-files guard is bypassable the same way.

## Remediation
Resolve realpath of the target's parent and refuse symlinked paths in read/write tools, or at minimum document the boundary.

### Issue #99: HYG-2 [oss-prep][HIGH] npm bin broken from a clean install

## Severity
HIGH (blocking)

## Audit area
oss-prep

## Location
`package.json:10` bin → `src/cli.ts` whose shebang is `#!/usr/bin/env tsx` (`src/cli.ts:1`), and tsx is a devDependency (`package.json:32`). Repo already works around this in `scripts/run-tests.mjs:44` (node_modules/.bin walk-up), `scripts/install-cli.sh:24`, and `docker/Dockerfile:81` (explicit wrappers).

## Description
On clean `npm install -g`, env finds no tsx on PATH → every invocation fails "tsx: not found".

## Remediation
Ship a small JS launcher as bin that resolves the package's own node_modules/tsx and sets TSX_TSCONFIG_PATH to the package's tsconfig.json (required for the vscode→shim path aliases, `tsconfig.json:16`).


## Review findings to fix (from the automated review)

1. FINDING — issue #99 (REOPENED): `.harness.pgid` committed and shipped in the npm tarball.**
2. Commit `9ef4ba5` (the #99 rework) adds `.harness.pgid` (content `2931482`, a live worker process-group id). Not on master; not in the #64 commit `aa472e4`; tracked in HEAD.
3. It is a runtime artifact by the repo's own documentation: `src/orchestrator/cleanup.ts:82` lists it as a known-safe untracked artifact, `.gitignore` groups harness bookkeeping as "must never be committed from a worktree", and issue #38 treats it as regenerable.
4. Consequence: `npm pack` now ships `package/.harness.pgid` (verified inside `headlesscode-0.1.0.tgz`) — the published artifact leaks a live process group id. The sibling `.harness.exit` also packs (pre-existing pack-hygiene territory of issue #100, but `.harness.pgid` is a regression introduced by this PR).
5. Fix needed: `git rm .harness.pgid`, add a root-anchored ignore pattern (`/.harness.pgid` next to `/.harness.pid`), re-pack and confirm absent. This is a hygiene regression, not a boot failure — the functional #99 fix itself verifies clean.
6. Evidence: `git log --oneline master..HEAD -- .harness.pgid` → `9ef4ba5`; `git cat-file -e master:.harness.pgid` → not on master; `tar -tzf headlesscode-0.1.0.tgz | grep harness` → `package/.harness.pgid` present; file contents `2931482`.
7. Issue #64 — verified CLEAN (left closed).** All 8 path-safety tests pass; I also ran 9 independent live attack checks (read/write-through-escaping-symlink refused, protected-file `id_rsa` bypass refused with outside file untouched, apply_diff/list_files/execute_command-cwd refused, internal symlink works, `escape/../secret.txt` dot-dot-through-symlink cannot escape) — all passed. Guard is wired into every file tool (executor.ts:710/787/815/923/994/1156/1447), execute_command cwd (1292), codeintel (handlers.ts:78), dashboard API (files.ts:47,87 → 400 via `instanceof PathTraversalError` at server.ts:583/665 — `SymlinkEscapeError extends PathTraversalError` verified at executor.ts:357), vision (tool.ts:73), browser handler (188). No bypass found.

Your job: address EVERY finding above. Do not skip any. Do not claim a finding is fixed
without reproducing the fix for real.

## Workflow

1. Read each finding above and the relevant source files.
2. Fix every finding, following the project's own conventions and the rules files.
3. Re-verify for real (run the project's tests / boot check) and capture the output —
   output in a report is a claim, not evidence, until reproduced.
4. Commit with the issue number referenced, one logical change per commit.
5. Push the branch and update the PR (or open a new one if needed).
6. Post an UPDATED closing comment below on each issue using the required template, then
   re-close it (or leave it open with the updated report if it must stay open).

## Required comment template

Your issue-closing comment must use this exact structure (every section present; a section can
be 'N/A' with a reason, but a missing section is itself a review finding):
```
## Issue <n> — Closing Report (rework cycle 2)

### Files changed
<one line per file>

### Baseline (before)
<real output>

### Baseline (after)
<real output>

### Boot check
<real output or exact reason it didn't apply>

### Residual risk / notes
<anything not 100% certain>

PR: <link>
```

## Closing out

Once every finding is addressed and every assigned issue is re-closed with fresh evidence:
1. Finish with attempt_completion and a full summary of what you changed, the real baseline
   numbers, the boot check, and the PR link(s).
2. The harness records your completion automatically (exit code + .harness.done marker) —
   no separate phone-home step is needed.
3. Do not start on any issue not assigned to this worktree.

Scope: #64, #99 only — rework cycle 2.