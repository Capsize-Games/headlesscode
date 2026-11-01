# HeadlessCode RSI Self-Improvement — Session Brief

New session. Read this file first, then work. Parent session stays on the
upstream-fix campaign and Hetzner pipeline; do not touch those.

## Goal

Review the headlesscode codebase, fix what needs fixing, and run the RSI
loop on headlesscode itself (dogfood the bounded RSI harness against its
own repo). Workers are authorized for this job — use several in parallel
on genuinely independent subtasks (review areas, test gaps, docs drift),
serial where they share files.

## Starting facts (verified 2026-10-27)

- Repo: `~/Projects/headlesscode`, branch `master`, tree CLEAN
  (HEAD `a1887b3c`, previous `33ac57f7`). Keep it clean: commit completed
  work per the repo's own contribution rules, never rewrite history.
- It is a coding-agent harness (CLI + HTTP) with bounded RSI that can
  already target itself. Entry docs: `docs/recursive-self-improvement.md`,
  `docs/rsi-progress.md`, `docs/rsi-control-and-monitoring-direction.md`,
  `docs/evidence-journal.md`, `docs/security-verification.md`.
- CI runs typecheck + full suite + mock workflows; RSI gates include
  regression, frozen-proof, and hidden-verification checks.

## Operating rules for this job

1. Read `AGENTS.md`/`CONTRIBUTING.md` first and obey the repo's own gates.
2. Review before changing: correctness, security controls (the seven
   insider-risk principles in the README), test coverage, docs drift.
3. Every code change needs a regression test and must keep CI green.
   Evidence-required: quote test output, not impressions.
4. RSI-on-itself runs bounded: fixed task list, inference budgets,
   contained profile, evidence journal on. Any RSI candidate that fails
   gates is dropped with the reason recorded.
5. Never weaken a security gate to make a candidate pass. If a gate
   blocks legitimate work, flag it for the owner instead.
6. No history rewrites, no force pushes. Signing deferred (existing key
   issue) — do not block on it.

## Standing owner constraints (apply here too)

- Approved on everything technical, but: never touch `/opt/wxrq`,
  homeserver, keyrings, sudoers, systemd daemons, package DBs, kernel
  builds, or the live Hetzner pipeline (`/home/secwatch`, daemon,
  drainer, fix-worker). No public exposure of anything.
- Preserve data, configs, API compatibility, licenses (Apache-2.0 here).
- `5194`/`5195` stay localhost-only.
- Report per worker: what was reviewed, what changed, test evidence,
  what remains unverified. No success claims without observed runs.

## Box workers are IN scope (added 2026-10-27)

The live Hetzner pipeline — `github-mail-daemon.py`, `queue-drain.py`,
`fix-worker.py` (repo copies in `fleet-security-watch/operations/`) — is
part of the RSI target. It is the highest-value loop to improve: triage
accuracy, the fix-worker model loop (v1 ack loop live since 2026-10-27;
code-fix acting still unimplemented), evidence quality.

Live-safety rules (no exceptions):
- Review and rewrite code only in repo checkouts and sandboxes. Never
  hot-edit `/home/secwatch` live files, state, queue, or cron.
- Deployment to the box stays with the owner session (this window's
  parent). RSI session proposes; it does not deploy.
- The fix-worker model loop must keep: STOP kill-switch, post budget,
  unknown-tasks-stay-queued, mandatory regression test + evidence bundle
  per fix. Any proposal weakening these is rejected, not refined.
- No live posting in tests. Dry-runs only outside production paths.

## Suggested split

- Worker 1: code review of `src/rsi/` + roles/gates (correctness + bypasses).
- Worker 2: code review of permissions/containment/emergency controls.
- Worker 3: test-gap analysis (what the suite does not cover) + add tests.
- Worker 4 (after 1–3 land): run bounded RSI-on-itself cycle on one
  well-scoped target from the reviews, with evidence.
