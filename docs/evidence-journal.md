# Evidence journal

The evidence journal stores complete, bounded session records outside the
workspace event feed. The worker-facing client can submit append requests for
one authorized session. `FileEvidenceCollector` owns the Ed25519 private key,
record files, and session authorization table. It signs each append receipt and
the current session head. Records use canonical JSON, a monotonically
increasing sequence, and a digest of the preceding record. A request ID is
idempotent: repeating the same request returns its original receipt; reusing it
for different content fails. The collector synchronizes each record and signed
head before acknowledging it. Records larger than the configured limit are
rejected, never shortened.

## Start and connect

The supervisor starts exactly one listener:

```ts
const collector = await FileEvidenceCollector.start({
  storageDir: "/var/lib/headlesscode/evidence",
  socketPath: "/run/headlesscode/evidence.sock",
  expectedKeyId: "sha256:<supervisor-pinned-key-fingerprint>",
})
const capability = await collector.authorizeSession(sessionId)
const journal = new UnixEvidenceJournal({
  socketPath: "/run/headlesscode/evidence.sock",
  sessionId,
  capability,
  pinnedPublicKey: collector.publicKey,
})
```

For a remote or separately hosted supervisor, configure the collector with an
HTTPS listener and TLS key/certificate, then use `HttpEvidenceJournal` with the
HTTPS base URL, the scoped session capability, the collector Ed25519 public
key, and the pinned TLS certificate SHA-256 fingerprint. The collector refuses
non-loopback HTTP without TLS; the remote client requires HTTPS and a matching
TLS certificate pin. Both clients validate each signed receipt against the
configured Ed25519 key. Provision the capability and socket/endpoint route
through the supervisor's authenticated setup channel. Do not place a token in
the record payload. The private key and storage path belong only to the
supervisor. Client requests time out after 15 seconds; collector requests have
the same timeout and enforce the configured record-size limit.

`evidenceJournalFromConfig(config)` constructs a client from a runtime-only
supervisor handoff object containing the scoped capability, session ID,
collector route, and pinned public key. `evidenceJournalFromEnv(env,
capability)` supports controlled CLI integration; it reads
`HEADLESSCODE_EVIDENCE_SESSION_ID`, `HEADLESSCODE_EVIDENCE_KEY_ID`,
`HEADLESSCODE_EVIDENCE_PUBLIC_KEY_B64`, and
exactly one of `HEADLESSCODE_EVIDENCE_SOCKET` or
`HEADLESSCODE_EVIDENCE_URL`. Remote URLs also require
`HEADLESSCODE_EVIDENCE_TLS_FINGERPRINT`. Set
`HEADLESSCODE_EVIDENCE_REQUIRED=1` to fail closed when an append cannot be
acknowledged. When the separate argument is omitted, the helper reads
`HEADLESSCODE_EVIDENCE_CAPABILITY`; the supervisor must protect this handoff
and keep the scoped token out of prompts, logs, event fields, and evidence
payloads. The capability grants append access to one session only.

The Ed25519 keypair is stored in the collector storage directory with private
permissions (`0700` directory and `0600` key). Keep that directory on a
supervisor-controlled volume and back up the public key separately. A collector
identity is `sha256:` followed by the SHA-256 digest of the DER SubjectPublicKeyInfo
bytes. A session head export is not a trust anchor by itself: the supervisor
must pin the public key and final signed head outside the worker's control.
Run `verifyEvidenceBundle(bundle, pinnedPublicKey, pinnedHead)` or the exported
file helper `verifyEvidenceFiles(bundlePath, keyPath, headPath)` to check the
signature, canonical digests, order, request replay, record count, and final
head. Verification returns a readable action history with each source label.

## Trust and deployment boundary

Records submitted through the worker's authenticated append capability are
always labeled `worker-reported`, including its model responses and claimed
tool outcomes. A valid signature proves which collector accepted the
submission; it does not prove that the worker's claim happened. Only a trusted
supervisor integration may use `appendObserved` for facts it independently
observed. Worker code must not receive a key, a delete or rewrite operation, or
direct access to the collector's storage directory.

Revoking a session disables further appends while retaining its records and
authorization hash for later export. The collector's exclusive storage lock
prevents a second process from appending concurrently. On restart, a record
tail that was written before a signed head and ACK were committed is discarded;
a signed head that advanced before capability metadata was saved is recovered
from the signed chain. A chain that does not match its signed head stops startup.

A separate directory or socket owned by the same unrestricted OS identity does
not isolate a compromised worker. Enforce the boundary with a different OS
identity, a contained execution profile, or a trusted broker that owns the
collector and exposes only the scoped authenticated append route. A Unix socket
must be mounted read/write into the guest by the supervisor and live outside
worker-writable roots and snapshots. Use the pinned HTTPS route or a trusted
broker when the guest cannot bind a host Unix socket. The collector does not
claim protection against a compromised supervisor, host administrator, or
storage administrator.

## Completeness and redaction

The loop records resolved task and condensation model requests and responses, complete tool intents
and results, model prompt/toolset/runtime/policy hashes, human-injected
messages, claim verification outcomes, and terminal session state. The
existing workspace JSONL event feed remains a truncated dashboard preview and
is explicitly non-authoritative. Full collector payloads are limited to 1 MiB
by default; configure a larger limit only when storage policy permits it.
Oversize records fail closed when evidence is required.

Before persistence, the collector redacts values under credential-like field
names, common bearer/API-key forms, and explicitly configured secret strings.
This can remove text from prompts, tool arguments, or results. Redaction is
therefore a documented loss of fidelity, and a redacted record must not be used
to claim that the original secret-bearing bytes were preserved. Review custom
secret values and the evidence retention policy with the supervisor.

When `evidenceRequired` is enabled, the loop waits for the intent receipt before
calling a tool. A missing intent acknowledgement prevents that call. A missing
result acknowledgement ends the session incomplete and blocks every later
effect. Required-evidence sessions condense synchronously, so auxiliary model
requests cannot outlive the terminal signed history. Terminal state recording
uses a separate bounded append after cancellation. The supervisor failure callback can stop the containing job; a
provided `AbortSignal` is composed with model request timeouts and checked
before each effect. Without `evidenceRequired`, the collector is optional and
local event logs are only operational diagnostics.
