# GitHub push-back: push a branch + open a PR — the missing "write" half of repo provisioning

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. `src/github/`
already has real, tested GitHub App infrastructure: `app-auth.ts` (real
installation-token auth via `@octokit/auth-app`, 59-minute cache/refresh) and
`provision.ts`'s `provisionRepo()` (clones a repo in using a fresh
installation token, then strips the token from the remote so it never
lingers in `.git/config`). **Confirmed by reading the code: there is no
push, no branch creation on the remote, and no PR creation anywhere in this
codebase.** `provisionRepo()` only ever reads FROM GitHub. This task builds
the write half — the piece needed so a `headlesscode orchestrate`/session
result run against a provisioned repo can actually get back to GitHub for a
human to review, rather than sitting in a local clone with no way out.

This is real, load-bearing work for `plans/uwuchat-integration.md`'s Tier 1
(an admin manages any project via `uwu`) — without this, the orchestrator
tool that plan describes has no way to deliver its output anywhere the
admin can actually see/review it. Read that plan doc's "Pushing work back to
GitHub" section for the full context if you want it, but this task file is
self-contained — you don't need to read the other plan to complete this one.

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh`.

## What to build

### 1. `src/github/push.ts` — push a branch using the installation token

New module, same pattern as `provision.ts`: get a fresh installation token
(via the same `getToken: () => Promise<string>` shape `provisionRepo`
already uses — reuse the type, don't redefine it), construct the
authenticated push URL the same documented way `provisionRepo` builds its
clone URL (`https://x-access-token:TOKEN@github.com/owner/repo.git`), run
`git push <that-url> HEAD:<branchName>` (or the equivalent two-step
`git remote set-url`/push/`git remote set-url` back-to-clean sequence
`provisionRepo` already uses for the SAME reason — the token must never
land in `.git/config` even transiently in a way that persists past this
call; verify your approach doesn't leave it behind, matching
`provisionRepo`'s own scrub-immediately-after discipline).

```ts
export interface PushOptions {
	installationId: number | string
	owner: string
	repo: string
	/** Local repo path to push from (already has the work committed). */
	localDir: string
	/** Branch name to push to on the remote (created if it doesn't exist). */
	branchName: string
	getToken: () => Promise<string>
	gitBin?: string
}

export async function pushBranch(options: PushOptions): Promise<void>
```

**Push to a named branch, never to the repo's default branch.** This is not
optional — reuse the same "never auto-merge, always leave a human review
surface" posture this project already applies everywhere else (the Step
3.5 review gate, PR-not-direct-merge in `plans/uwuchat-integration.md`).

### 2. `src/github/pr.ts` — open a PR via the REST API

New module, using the same installation token (Octokit's REST client is
already a dependency transitively via `@octokit/auth-app` — check whether
`@octokit/rest` or a plain authenticated `fetch` against
`POST /repos/{owner}/{repo}/pulls` is the right call; a plain `fetch` with
the token as a Bearer header avoids adding a new heavy dependency for one
endpoint — your call, but justify it in your report given this project's
"no new runtime dependency without a real reason" convention).

```ts
export interface OpenPrOptions {
	installationId: number | string
	owner: string
	repo: string
	head: string   // branch name pushed in step 1
	base: string    // target branch, e.g. "main"/"master" — the repo's actual default, don't hardcode
	title: string
	body: string
	getToken: () => Promise<string>
}

export interface OpenPrResult {
	number: number
	url: string
}

export async function openPullRequest(options: OpenPrOptions): Promise<OpenPrResult>
```

Determine the repo's real default branch rather than hardcoding
`main`/`master` — GitHub's repo API (`GET /repos/{owner}/{repo}`) returns
`default_branch`; use it, or accept an explicit `base` override if the
caller already knows it (e.g. `provisionRepo` could reasonably return this
too — check whether it's cheap to thread through, but don't over-engineer
this if it's simpler to just query it fresh here).

Handle the real failure mode honestly: a PR from `head` to `base` with no
diff between them (nothing to merge) is a real GitHub API error — surface
it as a clear error, don't silently succeed or retry.

### 3. CLI wiring: `headlesscode push-pr`

New subcommand in `src/github/cli.ts` (follow the exact structure/help-text
convention `provision`'s dispatch already uses in that file):

```
headlesscode push-pr --installation-id <id> --owner <o> --repo <r> \
  --local-dir <path> --branch <name> --title <title> --body <text> [--base <branch>]
```

Runs `pushBranch()` then `openPullRequest()`, prints the resulting PR
number + URL. Exit codes match this project's convention (0 success, 1
runtime failure, 2 usage/config error) — follow `provision`'s exact
pattern in `src/cli.ts`'s dispatch table.

### 4. Wire a convenience path for the orchestrate/session flow (small, don't over-build)

Check whether `src/orchestrator/cli.ts` or `src/engine/loop.ts`'s session
completion path has an obvious, cheap hook to OPTIONALLY call this (e.g. a
`--push-pr` flag on `orchestrate`/session commands that, when the
provisioning metadata is known, pushes + opens a PR automatically at the
end). If this is a natural, small addition given what's already there, do
it. If it would require significant plumbing to thread installation
id/owner/repo through the whole session lifecycle, **do NOT force it** —
leave the CLI subcommand as a standalone tool a caller (like
`plans/uwuchat-integration.md`'s future orchestrator tool) invokes
explicitly after a round finishes, and say so clearly in your report. This
project's own convention is small, focused additions — don't invent new
session-lifecycle coupling just to make this task feel more complete than
it needs to be.

## What NOT to do

- Do not push to a repo's default branch under any circumstance.
- Do not auto-merge the PR — opening it is the whole deliverable, merging
  is a human's job.
- Do not let the installation token persist in `.git/config` past the push
  call — match `provisionRepo`'s existing scrub discipline exactly.
- Do not add a heavy GitHub SDK dependency if a plain authenticated `fetch`
  against the one REST endpoint you need does the job — see the "no new
  runtime dependency without a real reason" convention in
  `.roo/rules/rules.md`.
- Do not force session-lifecycle wiring (item 4) if it doesn't fit cleanly
  — a standalone CLI subcommand is a complete, useful deliverable on its own.

## Tests

`src/github/__tests__/push.test.ts` and `src/github/__tests__/pr.test.ts`
(follow `src/github/__tests__/provision.test.ts`'s existing style — it
already tests against a fake git binary / fake token supplier, matching
this project's DI-for-testability convention used throughout):
- `pushBranch` constructs the correct authenticated URL, pushes to the
  named branch (never the default), and the token is not left in
  `.git/config` afterward (same assertion `provision.test.ts` already makes
  for clone — mirror it).
- `openPullRequest` posts the correct payload shape, handles a real "no
  diff" API error cleanly, returns `{number, url}` on success.
- CLI dispatch: `push-pr` argument parsing, usage/help text, exit codes for
  success/failure/missing-args.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. If you have a real GitHub App + a real (disposable/test) repo available,
   run the whole flow for real: provision → commit a trivial change → push
   → open PR → confirm the PR really exists via `gh pr view` or the API. If
   you do NOT have a real App/repo to test against, say so plainly (per
   `docs/github-app-setup.md`'s own note that this requires a human to
   register the App — not something you can do yourself) and describe
   exactly what you verified instead (unit tests against fakes, and a dry
   read of the real GitHub REST API docs for the exact payload shape).

## What to report back

- Files changed/added.
- Your choice on plain `fetch` vs. an Octokit REST client for the PR-open
  call, and why.
- Whether item 4 (session-lifecycle convenience wiring) was done, and if
  not, exactly why it didn't fit cleanly.
- Confirmation of tsc/test/e2e results.
- Whether the end-to-end flow was tested against a real GitHub App/repo, or
  only against fakes — say so plainly either way, per this project's
  standing honest-evaluation convention.
- Any deviation from this spec, and why.
