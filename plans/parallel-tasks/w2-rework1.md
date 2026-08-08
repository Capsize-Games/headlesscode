Before anything else: read `.roo/rules-code/rules.md` in full (or `.roo/rules/rules.md` if
rules-code is absent) and treat it as binding for this entire session, regardless of whether
it auto-loaded for whatever mode you're running in — don't assume it applied, read it yourself.

You are working autonomously in the SAME isolated git worktree as the previous attempt, on
the same branch. The automated adversarial reviewer found problems with that attempt. Read
this entire file before doing anything.

## Rework cycle 1 — address the review findings

Assigned issues: #7, #8. Fetch each issue's real body yourself (do not rely on a stale
copy of any issue body):
```
gh issue view 7
gh issue view 8
```

## Review findings to fix (from the automated review)

1. #7 — REOPENED (FINDING): `scripts/install-cli.sh` ships stack rules to a path the runtime never reads when `$HEADLESSCODE_DATA_DIR` is set.**
2. `scripts/install-cli.sh:28-37` — comment claims "Same location + override the runtime resolves: $HEADLESSCODE_DATA_DIR, else $HOME/.local/share/headlesscode/shared/stacks (see src/project-store.ts:projectStoreRoot + src/engine/stacks.ts)", and line 33 writes `STACKS_DEST="${HEADLESSCODE_DATA_DIR:-$HOME/.local/share/headlesscode}/shared/stacks"`.
3. `src/engine/stacks.ts:57-59` — `getCentralStackRulesDir()` returns `os.homedir()/.local/share/headlesscode/shared/stacks` unconditionally; the stack-rules loader never consults `HEADLESSCODE_DATA_DIR`. Only the sibling shared-instructions tier honors the override (`src/project-store.ts:58-61`, `src/engine/prompt.ts:218`). `docs/stack-rules.md:51` repeats the same false claim.
4. Demonstrated (real output): with a fresh `$HOME` and `HEADLESSCODE_DATA_DIR` set, install-cli.sh prints "Installed stack rules -> <data-dir>/shared/stacks" and copies both rules.md there, but the runtime read path (`<home>/.local/share/headlesscode/shared/stacks`) does not exist and a `--dry-run` against a python fixture splices **0** STACK-SPECIFIC instructions. The install reports success; the shipped content is unreachable — the "ships with headlesscode" guarantee is silently false under an override the codebase documents as a legit escape hatch and that its own tests use.
5. Actionable fix (either): route `getCentralStackRulesDir()` through `projectStoreRoot()` so it honors the override like `sharedInstructionsRoot()` does, then keep install-cli.sh as written; or drop the override branch from install-cli.sh and always install to `os.homedir()/.local/share/headlesscode/shared/stacks`. Update the comment/docs to match and add a check that content installed under the override actually gets spliced.
6. #8 — verified clean, no reopening.** Content matches issue scope; test is correct and runs in-suite.

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

Scope: #7, #8 only — rework cycle 1.