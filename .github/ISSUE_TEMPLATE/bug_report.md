---
name: Bug report
about: Report a bug in the harness
title: ""
labels: bug
assignees: ""
---

**Describe the bug**
A clear and concise description of what the bug is.

**To reproduce**
Steps to reproduce the behavior:
1. Run `...` with `...`
2. Point it at `...`
3. Observe `...`

**Expected behavior**
What you expected to happen.

**Environment (please complete the following)**
- OS / distro:
- Node version (`node --version`):
- Branch / commit (`git log -1 --oneline`):
- Relevant env vars set (e.g. `HEADLESSCODE_ALLOWED_COMMANDS`, `HEADLESSCODE_DATA_DIR`):

**Security note**
This agent executes arbitrary shell commands as the invoking user — if your
report involves untrusted prompts/repositories or the permission layer
(`src/permissions/`), read [`SECURITY.md`](../../../SECURITY.md) and prefer a
private report over a public issue.

**Logs / output**
Paste the relevant terminal output or `harness.log` excerpt.

**Additional context**
Anything else that might help — config files, `.roomodes`, the target repo's
`.roo/` setup, etc.
