Project and mode-specific rules (from the central shared store and this project's own
.roo/rules*) are already spliced into your system prompt automatically — you do not
need to read any rules file yourself.

You are working autonomously in the SAME isolated git worktree as the previous attempt, on
the same branch. The automated adversarial reviewer found problems with that attempt. Read
this entire file before doing anything.

## Rework cycle 1 — address the review findings

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

1. ### FINDING — issue #99 (npm bin broken from clean install) still broken under a REAL npm install; reopened
2. File:line evidence**
3. tsconfig.json:16-22 — `paths` aliases (`@roo-code/types`, `vscode`, `os-name`, `strip-bom`, `@anthropic-ai/sdk`) map to files inside the package (`./src/vendor/zoo-code/types/index.ts`, `./src/vendor/zoo-code/shim/vscode.ts`, …).
4. src/vendor/zoo-code/src/shared/modes.ts:1-10 — bare `import ... from "vscode"` and `from "@roo-code/types"` rely on those tsconfig paths.
5. bin/headlesscode.mjs:63-70 — the launcher pins `TSX_TSCONFIG_PATH` to the package tsconfig and re-execs through the package's own tsx. This works only when tsx actually applies the tsconfig `paths` to the importing files.
6. package.json:11 — `"headlesscode": "bin/headlesscode.mjs"` is the npm bin entry, so the failure surfaces through the exact path this issue is about.
7. Real reproduction (fresh, today, from the packed tarball):**
8. ```
9. $ npm pack          # headlesscode-0.1.0.tgz
10. $ npm install -g --prefix /tmp/hc-prefix ./headlesscode-0.1.0.tgz
11. $ cd /tmp && /tmp/hc-prefix/bin/headlesscode --version
12. Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@roo-code/types' imported from
13. /tmp/hc-prefix/lib/node_modules/headlesscode/src/vendor/zoo-code/src/shared/modes.ts
14. EXIT=1
15. `--dry-run` fails identically (exit 1). A regular consumer install (`npm install <tarball>` then `npx headlesscode --version`) fails the same way. The bin is still broken from a clean install — the error just changed from `tsx: not found` to `ERR_MODULE_NOT_FOUND @roo-code/types`.
16. Root cause (proven, not hypothesized):** npm installs the package under `<prefix>/lib/node_modules/headlesscode`, i.e. `src/` ends up inside a `node_modules` directory. tsx deliberately skips applying tsconfig `paths` aliases to files under node_modules (they should resolve via package resolution). Controlled experiment with the identical tree:

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
## Issue <n> — Closing Report (rework cycle 1)

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

Scope: #64, #99 only — rework cycle 1.