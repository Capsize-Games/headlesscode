## Summary

<!-- What does this change do, and why? Reference the issue(s) it closes, e.g. "Closes #100". -->

## Verification

<!-- Real evidence, not claims. Paste actual output. -->

- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` passes in full (paste the `All N tests passed` trailer)
- [ ] `npm pack --dry-run` output shows the intended tarball contents (if
      `package.json` / packaging changed)
- [ ] e2e suites re-run if the change touches `src/orchestrator/`,
      `src/watcher/`, or `scripts/*.sh` (`scripts/e2e*/run.sh`)

## Security impact

<!-- This agent executes arbitrary shell commands as the invoking user. If
this change touches `src/tools/executor.ts`, `src/permissions/`, scripts,
or anything that reads secrets/env, describe the security implications and
how least privilege is preserved. If not applicable: N/A. -->

## Test plan

<!-- How a reviewer should verify this. Include the exact commands. -->
