# GitHub App setup (manual, one-time, by the project owner)

This document is the **manual, human-only** prerequisite for
[`headlesscode provision`](../src/github/cli.ts) (and, later, anything built on
the provisioning primitive in [`src/github/`](../src/github/)). Registering a
GitHub App requires a human with admin access on the target GitHub account/org
clicking through GitHub's own UI — **no code can do this for you**.

This is a **security-sensitive surface**: the App you create below has write
access to any repo it is installed on (Contents read/write is required so a
worker can push branches). Treat the permission scope as a deliberate,
reviewed decision — do NOT broaden it casually.

---

## 1. Create the GitHub App

1. Go to **https://github.com/settings/apps/new** (for a personal account) or
   the org-level equivalent (**Settings → Developer settings → GitHub Apps →
   New GitHub App**) on the account/org you want to install it on.
2. Fill in:
   - **GitHub App name** — anything unique, e.g. `headlesscode-dev`.
   - **Homepage URL** — any reachable URL (e.g. the repo URL).
   - **Webhook** — leave **Webhook URL blank** and **Disable webhooks**
     checked. This round is pull-based provisioning only; webhook handling is
     explicitly out of scope.
3. **Repository permissions** — request exactly these three, nothing more
   (least privilege):

   | Permission       | Access level          | Why                                                  |
   | ---------------- | --------------------- | ---------------------------------------------------- |
   | **Contents**     | **Read & write**      | A worker must clone and push branches                |
   | **Pull requests**| **Read & write**      | A worker must open/update PRs                        |
   | **Metadata**     | **Read-only**         | Mandatory; required by the repo-listing API          |

   Do **not** request broader permissions unless a concrete need shows up.
4. **Where can this GitHub App be installed?** — choose *Any account* or the
   specific account/org you control.
5. Click **Create GitHub App**.

## 2. Generate and download the private key

On the App's settings page (**https://github.com/settings/apps/<app-name>** or
the org equivalent):

1. Scroll to **Private keys**.
2. Click **Generate a private key**.
3. GitHub downloads a `*.pem` file. **Treat this file like a password** — it is
   the durable secret that lets anyone holding it mint installation tokens for
   every repo the App is installed on. Store it somewhere safe (e.g. a secret
   manager); never commit it to this repository.

## 3. Where the credentials go

`headlesscode provision` reads everything from environment variables
(matching this project's env-var-first config convention; the existing
[`src/cli.ts`](../src/cli.ts) documents env vars the same way). For local dev,
put them in the repo's `.env` (which is gitignored — see
[`.gitignore`](../.gitignore)):

```bash
# .env (local dev only — never committed)
GITHUB_APP_ID=123456                  # numeric App ID, from the App settings page
GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/to/headlesscode-dev.2026-01-01.private-key.pem
```

Two ways to supply the key (pick one):

- `GITHUB_APP_PRIVATE_KEY` — the full PEM text inline:
  `GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY----- ..."`
- `GITHUB_APP_PRIVATE_KEY_PATH` — path to the downloaded `.pem` file
  (recommended for local dev; the `.pem` never has to be in the repo at all).

Also respected, for tests/mocks:

- `GITHUB_API_BASE_URL` — GitHub API base URL override (default
  `https://api.github.com`).

**Hard rules:**

- The private key must never be committed, logged, or embedded in test
  fixtures. The repo's `.gitignore` already excludes `.env`, `.env.*`,
  `*.pem`, and `*.key`; keep it that way.
- Installation access tokens are **ephemeral by design** (1 hour validity).
  They are held in memory only, keyed by installation ID, and refreshed
  before expiry — never written to disk, never embedded in a cloned repo's
  `.git/config` (the clone URL is scrubbed to a plain token-free URL
  immediately after cloning).

## 4. Install the App on a test account/org (and get the installation ID)

1. On the App settings page, click **Install App** (top-right).
2. Choose the account/org and select **Only select repositories** — pick at
   least one **test/throwaway repo** (use a repo you don't mind a worker
   pushing branches to).
3. After installing, GitHub redirects to the installation page whose URL ends
   in a number — that number is the **installation ID**:
   `https://github.com/settings/installations/<INSTALLATION_ID>`

You now have all three pieces: the App ID, the private key, and an
installation ID to develop and test against.

## 5. Try it

```bash
# List the repos the installation can access (the repo-picker primitive)
npx tsx src/cli.ts provision --list-repos <INSTALLATION_ID>

# Clone a repo the installation can access into a local dir
# (token stripped from the remote URL immediately after cloning)
npx tsx src/cli.ts provision \
  --installation-id <INSTALLATION_ID> \
  --owner <owner> \
  --repo <repo> \
  --target /tmp/headlesscode-clone

# The printed path is ready to use as a --workspace value, e.g.:
npx tsx src/cli.ts orchestrate --repo /tmp/headlesscode-clone --issue <n>
```

## Troubleshooting

- **`401`/`403` from the token exchange or clone** — the App isn't installed
  on that account/org, the installation was removed, or the App's
  permissions were changed. Re-check step 4 and the three permissions in
  step 3.
- **`404` on a repo** — the App is installed but that specific repo wasn't
  selected (or the owner/repo name is wrong). Check the installation's
  repository selection.
- **Clock skew** — GitHub rejects JWTs issued too far from server time; the
  auth library accounts for standard skew, but if the host clock is badly
  wrong, tokens will fail until it's corrected.
