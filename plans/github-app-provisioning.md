# GitHub App integration + repo provisioning — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI/orchestration engine. Today, every entry
point assumes a repo is ALREADY a local git checkout on the machine running
headlesscode (`--workspace <path>`, worktrees created via `git worktree add`
against an existing local repo). This task builds the layer underneath that
assumption: given a GitHub repo a user has granted access to, produce a real
local clone headlesscode can operate on — the prerequisite for ever running
this against an arbitrary user's repo from a hosted server, rather than only
repos that happen to already be checked out on this specific machine.

Match this project's established style where it still applies: no test
framework (plain `tsx`-run test files, `All N tests passed` trailer);
`npx tsc --noEmit` and `npm test` must stay green. **Exception to the
"minimal dependencies" rule, stated explicitly so it isn't second-guessed**:
GitHub App authentication requires RS256 JWT signing and a defined token-
exchange protocol — hand-rolling that insecurely is a worse outcome than
taking a real, maintained dependency. Use `@octokit/auth-app` (the
standard, GitHub-maintained library for exactly this) rather than
implementing JWT signing by hand.

## Part 0 — manual setup the project owner does, not you

You cannot register a GitHub App yourself — it requires a human with admin
access on the relevant GitHub account/org clicking through GitHub's own UI.
Write clear setup documentation (`docs/github-app-setup.md`) covering:
- Creating a GitHub App at `https://github.com/settings/apps/new` (or the
  org-level equivalent) with: Repository permissions → Contents (Read &
  write, so a worker can push branches), Pull requests (Read & write),
  Metadata (Read-only, mandatory). Do NOT request broader permissions than
  these three unless a concrete need shows up later — least privilege.
- Generating and downloading a private key (`.pem`) for the App.
- Where the App's numeric ID, the private key, and (once installed on a
  test account/org) the installation ID need to end up: environment
  variables (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` or
  `GITHUB_APP_PRIVATE_KEY_PATH`, following this project's existing
  convention of env-var-first config with `.env` for local dev — check
  `src/cli.ts`'s existing env var docs for the naming style to match).
- Installing the App on at least one test repo, to get a real installation
  ID to develop and test against.

Do not proceed to write code that assumes these exist without a human
having actually done this — if you don't have a real App/installation to
test against, build against the documented API shape and say so clearly in
your report (see "What to report back").

## What to build

### 1. GitHub App auth client

New `src/github/app-auth.ts`, wrapping `@octokit/auth-app`: given the App
ID + private key (from env, per Part 0) and an installation ID, produce a
short-lived installation access token. Cache tokens in memory only, keyed by
installation id, and refresh before expiry (GitHub installation tokens are
valid for 1 hour) — **never persist a token to disk**; the App ID + private
key are the durable secret, tokens are deliberately ephemeral, treat them
that way in this codebase too.

### 2. List repos an installation can access

New function in the same module (or a sibling `src/github/installations.ts`):
given an installation id, call GitHub's "list repositories accessible to the
app installation" API and return `{ owner, name, fullName, defaultBranch }`
for each. This is what a "choose a project" UI (built elsewhere, later) would
call to populate a repo picker — this task only needs the underlying
function + a way to exercise it, not the UI itself.

### 3. Provisioning: installation + repo → local clone

New `src/github/provision.ts`: `provisionRepo({ installationId, owner, repo,
targetDir })` — gets a fresh installation token (via step 1), constructs an
authenticated clone URL (`https://x-access-token:<token>@github.com/<owner>/<repo>.git`
— confirm this is still GitHub's current recommended pattern for App
installation tokens before hardcoding it, their docs are the source of
truth, not assumption), and clones into `targetDir` (create if missing, fail
clearly if it already exists and isn't empty — don't silently overwrite).
Returns the local path, ready to be used as a `--workspace` value for
everything else in this project (an `orchestrate` round, a single session,
etc.) — this function's whole job is producing exactly what the rest of the
codebase already expects, no changes needed downstream.

- Token never touches disk, including never being embedded into the
  cloned repo's own `git remote` URL after the initial clone (rewrite the
  remote to a plain `https://github.com/<owner>/<repo>.git` immediately
  after cloning, so a stale token doesn't linger in `.git/config` — verify
  this actually happens with a test, not just by reading your own code).

### 4. CLI subcommand for testing/manual use

New `headlesscode provision --installation-id <id> --owner <o> --repo <r>
--target <dir>` (mirror the existing subcommand dispatch pattern in
`src/cli.ts`). Prints the resulting local path on success. This is the
manual/scriptable entry point ahead of any future web UI calling the same
underlying function directly.

### What NOT to do

- Do not build webhook handling (installation created/removed, push events)
  — explicitly out of scope for this round; this task is the pull-based
  "give me this repo, right now" path only, not push-triggered automation.
- Do not build a repo-picker UI or any dashboard integration — this task is
  the provisioning primitive underneath one, not the UI itself (that's a
  later, separate task once real multi-tenant hosting is being built).
- Do not request or use any GitHub permission beyond the three listed in
  Part 0 without flagging it in your report first — this is a security-
  sensitive surface (an App with write access to potentially many users'
  repos), treat permission scope as a deliberate, reviewed decision, not
  something to expand casually because it'd be convenient.
- Do not commit the App's private key or any real installation ID/token
  anywhere in this repo, including in test fixtures — use fake/redacted
  values in tests and `.gitignore` anything that might accidentally hold a
  real one locally during development.

## Tests

- New `src/github/__tests__/app-auth.test.ts`: token caching actually
  avoids a redundant token-exchange call for the same installation within
  the cache window (prove with a call counter on a faked token-exchange
  function, not just by reading the code), and does refresh once the
  cached token is past its expiry — use a fake/injectable clock, don't
  sleep for real in a test.
- New `src/github/__tests__/provision.test.ts`: clones into an empty
  target dir successfully (point it at a real small local bare repo you
  create as a test fixture — no real GitHub network call needed for this
  part, git itself doesn't care that the "remote" is local), refuses to
  clone into a non-empty target, and — the important security property —
  confirms the resulting `.git/config` remote URL does NOT contain the
  token string used during clone.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. `npm test`'s existing suites (everything not in `src/github/`) must be
   completely unaffected — this task adds a new, separate subsystem, it
   should not need to touch any existing file's behavior.
4. If you have a real test App + installation (per Part 0): a real manual
   smoke test — provision a real (throwaway/test) repo, confirm the clone
   is real and correct, confirm the token doesn't leak into `.git/config`.
   If you don't have real credentials, say so plainly rather than claiming
   this was verified end-to-end.

## What to report back

- Files changed/added, including `docs/github-app-setup.md`.
- Whether you had a real GitHub App + installation to test against, and if
  not, what you verified instead (request/response shapes against GitHub's
  documented API, without a live call).
- Confirmation of tsc/test results (actual pass/fail counts).
- The exact permission scopes you configured/documented, restated plainly
  so they're easy to review, not buried in a diff.
- Any deviation from this spec, and why.
- Anything you noticed while doing this that looks like a related bug or
  gap, even if unfixed — flag it rather than ignoring it.
