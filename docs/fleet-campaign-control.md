# Fleet campaign control

HeadlessCode exposes two separate controls: the legacy global Fleet adapter and
registered per-repository campaigns. Their switches and readiness are separate.
Enabling the global adapter does not enable a repository campaign.

## Legacy global adapter

The optional `headlesscode campaign` commands control the locally registered
Fleet adapter:

- `campaign status` reads the global switch, budget allocation and run history.
- `campaign on` and `campaign off` change admission for the legacy adapter.
  OFF blocks new work while accepted work retains its cleanup and evaluation
  path.
- `campaign budget --usd <amount>` sets the shared monthly limit. The limit
  cannot discard committed or ambiguous spend.
- `campaign tick` runs the fixed adapter under a non-overlap lease. The ordinary
  owner-managed schedule invokes it; Codex timers do not.
- `campaign serve` exposes the loopback control API on port 4391. It does not
  expose the public CVE catalog.

The legacy budget remains part of the existing shared monthly authority; it is
not a separate allowance for repository campaigns.

## Per-repository campaign status

The additive repository coordinator keeps campaign definitions, claims,
readiness, job history and worker registrations in separate owner-controlled
state. Browser requests cannot set trusted source, worker, policy, model,
access or evaluator qualifications. A campaign is runnable only when the
owner-provisioned definition and exact worker registration satisfy those
checks.

The current repository definition is the Curl entry for CVE-2026-92390. Code
includes the fixed evaluator profile `curl-92390-fixed-v1` and a
qualification-only preflight for its pinned source proof. That proof does not
establish worker qualification and the preflight is not a patch worker or a
general advisory approval. The live private worker registry is empty and the
campaign definition reports `workerQualified=false`. The Curl campaign is
disabled and blocked on prerequisites. No live CVE worker is currently
runnable or claimed.

As of 2026-10-29, the legacy global admission switch is ON at control epoch 22.
That state does not change the Curl campaign's disabled, blocked-prerequisite
state. Do not describe qualification-profile code or historical jobs as a live
worker run, verified repair, upstream submission or catalog publication.

The protected budget and stop controls remain authoritative for any future
repository worker. A stopped or blocked campaign must not be started until its
registered source, worker, fixed recipe, evaluator, data access and model
qualifications are independently present and verified.
