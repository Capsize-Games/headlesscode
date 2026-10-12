# Runner pool — home node runbook (issue #32)

Claim-based two-machine pool: the home node (`joe@192.168.1.252`) and the
workstation each run one continuous `headlesscode watch` with a distinct
`--runner-id`. Jobs (issues carrying the watcher label) go to whichever
machine has capacity. There is no central balancer and no new infra — the
GitHub claim refs (`headlesscode-claims/issue-N`, see
[`src/watcher/claims.ts`](../src/watcher/claims.ts)) are the coordination
primitive. The alternative (central dispatcher SSH-dispatching to the node)
was decided against: claim-based balancing is the implemented design.

## 1. Install (home node)

On the node, as the service user:

```bash
# 1. Prerequisites: Node.js 22.19+, git, gh
node --version   # >= 22.19
git --version
gh --version     # needed by worker workflows that shell out to gh

# 2. Clone + install headlesscode deps
git clone <repo-url> /opt/headlesscode
cd /opt/headlesscode
npm ci

# 3. Clone the target repo the watcher will spawn worktrees in
git clone <repo-url> /opt/my-repo

# 4. Optional CLI shim
bash /opt/headlesscode/scripts/install-cli.sh
```

`gh` is not used by the watcher itself (it uses the GitHub REST API), but
worker jobs invoke the GitHub CLI — install and authenticate it on the node
the same way as on the workstation.

## 2. Credentials (per machine, never copied)

Create one fine-grained token per machine with repository **Contents
read/write** (claim refs) and **Issues read/write** (lifecycle labels,
assignees, comments). Store it in a protected environment file, never in the
unit file or command line:

```bash
sudo install -o headlesscode -g headlesscode -m 0600 /dev/null /etc/headlesscode/runner.env
# then edit /etc/headlesscode/runner.env:
#   GH_TOKEN=ghp_...
#   HEADLESSCODE_RUNNER_ID=home-node
#   HEADLESSCODE_RUNNER_ASSIGNEE=<bot-login>
```

Do not copy model-provider credentials between machines; provision each
runner's credentials through the deployment's approved secret mechanism.

## 3. Run (systemd, one watcher per machine)

```ini
# /etc/systemd/system/headlesscode-watch.service (home node)
[Unit]
Description=headlesscode GitHub issue watcher (runner-pool node)
After=network-online.target

[Service]
Type=simple
User=headlesscode
EnvironmentFile=/etc/headlesscode/runner.env
WorkingDirectory=/opt/headlesscode
ExecStart=/usr/bin/npx --prefix /opt/headlesscode tsx /opt/headlesscode/src/cli.ts watch --owner my-org --repo /opt/my-repo --label needs-agent --runner-id home-node --runner-assignee <bot-login> --max-concurrent-sessions 1 --poll-interval-ms 60000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

The workstation uses the same unit with a different `--runner-id`
(e.g. `workstation`) and its own env file. `HEADLESSCODE_RUNNER_ID` /
`HEADLESSCODE_RUNNER_ASSIGNEE` env vars may replace the two flags.

## 4. Per-machine capacity cap

`--max-concurrent-sessions` (default `$HEADLESSCODE_MAX_CONCURRENT_SESSIONS`
or 3) is the **per-machine** cap in pool mode: orchestrator groups in
`spawned`/`running` + watcher in-flight entries + active claim worktrees held
by this runner. Issues beyond it stay `pending` and are picked up on a later
sweep once slots free up. Size each machine independently (e.g. node `1`,
workstation `2`–`3`). Keep exactly one pool watcher per machine: the watcher
takes an exclusive lock under `$XDG_STATE_HOME/headlesscode`
(or `~/.local/state/headlesscode`) and two local watchers with different
runner ids would each consume the full cap independently.

Lease tuning: `--claim-lease-ms` (default 120000, valid 30000..900000;
env `HEADLESSCODE_CLAIM_LEASE_MS`). The poll interval must be at most half
the lease so the watcher renews in time — the watcher rejects a longer
interval at startup.

## 5. Claim discipline

- **Claimed = assignee set + active claim ref.** The assignee
  (`--runner-assignee`) is a visible indicator only; the authoritative record
  is the `headlesscode-claims/issue-N` ref. Runners acquire via atomic
  ref-creation / non-forced fast-forward CAS, renew every sweep, and record
  their nonce + epoch in local watcher state.
- **Do not delete claim refs.** A released ref stays in place so the next
  acquisition increments the epoch and cannot reuse an old claim (no ABA).
- **Pool mode needs continuous operation.** `--run-once` is rejected with
  `--runner-id` because a single sweep cannot renew leases.
- **Renewal failure is fail-closed.** When GitHub cannot confirm a renewal,
  the watcher stops local worker process groups where possible and keeps the
  claim active — it never releases a claim it cannot prove is torn down.

## 6. Stale-claim recovery

Expired active claims are **quarantined, not reassigned**: a runner may
release only a reservation that never dispatched (`stage: reserved`,
`release(..., { kind: "never-spawned" })`). Once a worker could have started,
worktree markers (PID/PGID files, `.harness.done`, sandbox markers) are not
trustworthy teardown proof — they live in worker-writable trees.

Recovery procedure:

1. Verify out of band that the old host's worker process groups are absent
   **and** any guest resources are gone. If the machine cannot be inspected,
   leave the claim quarantined — do not infer teardown from lease expiry.
2. An authorized operator calls `GitHubIssueClaimStore.recoverExpired()`
   (see [`src/watcher/claims.ts`](../src/watcher/claims.ts)) with the current
   ref tip, runner id, nonce, epoch, operator login, bounded evidence text,
   and explicit terminal-state confirmation. The method rejects an unexpired
   lease or a changed tip, and records the operator + evidence in the released
   claim commit. That API records the operator's declaration — it cannot
   independently prove remote teardown.

See [Phase 5 watcher](./phase5-issue-watcher.md) § "Claim-based runner pool"
for the full semantics.
