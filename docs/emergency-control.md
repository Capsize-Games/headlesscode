# Emergency controls

The supervisor can expose a local emergency-control endpoint for a session or
RSI worker. It stores state outside the candidate workspace under
`~/.local/share/headlesscode/control` by default. Set
`HEADLESSCODE_CONTROL_DIR` to use another supervisor-owned directory. Set
`HEADLESSCODE_CONTROL_SOCKET_DIR` when the default control directory is too
long for the operating system's Unix socket path limit. State and Unix socket
files are restricted to the current operating-system user, and an exclusive
instance lock prevents a second controller from replacing a live endpoint.

Use `headlesscode-control <identity> status` to inspect the recorded state.
Use `headlesscode-control <identity> pause --reason "..."` to stop current work
and keep the session paused. Resume requires an explicit
`headlesscode-control <identity> resume`; ordinary developer pause markers do
not change this security state. Use `headlesscode-control <identity> stop
--reason "..."` for a terminal stop.

Each pause or stop advances the fencing epoch and records the operator's local
UID, reason, request and acknowledgement times, cleanup results, and resources
that remain. A stalled external evidence recorder leaves `evidenceStatus` as
`pending` or `failed` in the fsynced control record; it cannot delay cleanup.
Active model requests and guest commands receive an abort signal.
RSI cancellation fences the database lease, blocks its inference capability,
and rejects later heartbeat or completion writes. A worker does not report a
guest as stopped until OpenShell no longer lists its sandbox. Failed teardown
keeps the resource recorded and leaves the state at `failed-to-stop` for
operator recovery. On worker restart, persisted sandbox and job resources
remain failed-to-stop until the worker reconstructs teardown, re-fences the
job, and verifies the sandbox is absent.

The controller can terminate the OpenShell CLI process group it started and
request sandbox deletion. Process-group termination does not contain arbitrary
processes that deliberately detach from that group. In trusted local execution,
the process runs with the invoking user's permissions; the controller does not
claim to contain such a process.
