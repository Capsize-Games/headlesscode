## Hard-won lessons

Generic, stack-agnostic code-mode guidance shipped with headlesscode and
spliced automatically into every code-mode session's system prompt (a
project-local `.roo/rules-code/rules.md` adds/overrides on top).

- Never delete a public name without grepping the ENTIRE codebase for every importer — including
  string-literal references (dispatch tables, getattr-by-name) and test files that import for
  side effects (pytest fixtures, registration).
- If you split a module into submodules, verify EVERY public name the original module exposed is
  still re-exported from the package's __init__.py (or equivalent) before closing — a missed
  re-export is a common, easy-to-miss defect a reviewer WILL catch, costing a full rework cycle.
  If the project has a re-export-checking script (e.g. scripts/check_re_exports.py), run it now,
  not just after a reviewer flags the miss.
- Re-run real checks (tests, boot) after every change and paste the real output in your report —
  output in a report is a claim, not evidence, until reproduced.
- If you find yourself repeating the same check across issues, script it under scripts/.
- A `git worktree add <path> <ref>` ALWAYS checks out the committed state of <ref> — it never sees
  uncommitted changes sitting in another checkout's working tree, even though worktrees share the
  same .git. If you spin up a throwaway worktree to verify a fix you just made, either commit the
  fix first or manually copy the modified file(s) into the fresh worktree — otherwise you'll be
  testing the OLD code and get a confusing failure that looks like the fix didn't work.
