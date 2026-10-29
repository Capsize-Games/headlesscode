# Fleet campaign integration

The optional `headlesscode campaign` commands control a locally registered
Fleet adapter. The registration identifies an immutable verified Fleet
release and its private state directory; it is not a general command runner.

- `campaign status` reads actual switch, allocation and history.
- `campaign on` and `campaign off` persist admission state. OFF stops new jobs;
  accepted work retains its cleanup/evaluation path.
- `campaign budget --usd 5` sets the shared monthly maximum. Lower values are
  supported; committed and ambiguous spend cannot be silently discarded.
- `campaign tick` runs the fixed adapter under a non-overlap lease. The
  owner's ordinary OS schedule invokes it; there is no Codex timer.
- `campaign serve` provides the loopback control API used by the shared local
  dashboard. It must not be exposed as the public CVE catalog.

The private registration normally lives at
`~/.local/share/headlesscode/campaign-control/fleet-adapter.json`.
Credentials, registrations, databases and machine inventory are not release
source. The sibling Fleet repository documents configuration and supported
package recipes in `docs/AUTOMATION.md`.

## RSI status

The separate campaign RSI binding is restricted to public synthetic intake
fixtures, one mutable source file, protected evaluation/policy, a frozen
runtime image and finite shared-ledger call/token/spend limits. It does not
enable general CVE research or production deployment. Candidate promotion is
explicit; a model response cannot approve itself.

The measured October 29 experiment failed without a patch or promotion:
three settled calls, 10,132 tokens, $0.000538, zero ambiguous spend. The idle
worker was stopped. Campaign tool filtering now enforces a four-tool ceiling;
metadata-discovery denial qualification still requires repair and retesting.
The integration release therefore does not claim a qualified production RSI
loop. Previously refused operations remain stopped.
