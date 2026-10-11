# RSI hidden function verification

RSI hidden checks use a supervisor-owned suite of declarative exported-function cases. The suite contains module paths, export names, inputs, and expected JSON outputs. The host validates and freezes the suite before baseline evaluation, then sends only the bounded case inputs to a fresh OpenShell evaluator snapshot. The candidate process never receives expected outputs, the signing key, or the suite file. A fixed driver invokes only the declared exported functions; arbitrary hidden shell commands are refused.

The host compares returned JSON values with its private expected values. A host Ed25519 key signs the result, and verification requires the operator-pinned public key, protocol and suite digest, approved evaluator image digest, candidate source tree digest and commit, session/job IDs, fresh nonce, and frozen resource limits to match. The durable nonce store rejects replay. Runner errors, thrown candidate functions, non-JSON values, resource-limit failures, missing or partial outputs, and mismatches fail evaluation.

The OpenShell provider receives the evaluator image by immutable `sha256` digest, a CPU limit of one, and the suite memory limit in MiB. The fixed driver also sets a bounded Node.js old-space limit and CPU-time ceiling. This depends on the configured OpenShell provider enforcing its `cpu` and `memory` settings. If a provider is unavailable, rejects those settings, or cannot start the digest-pinned evaluator, the hidden check fails closed. The verifier does not claim protection against a compromised host, OpenShell control plane, pinned evaluator image, or operator key.

Prepare the suite, Ed25519 key pair, and nonce store in an operator-controlled directory outside the repository, RSI archive, and candidate worktree directory. Protect each file with mode `0600`; keep the suite and private key private. Approve the canonical suite digest and evaluator image digest through the operator's deployment process. The suite digest can be computed with the exported `hiddenFunctionSuiteDigest` helper from `src/rsi/hidden-verifier.ts`.

Run RSI with all six options; partial configuration is rejected:

```sh
headlesscode improve \
  --repo /path/to/repository \
  --hidden-suite /secure/operator/hidden-suite.json \
  --hidden-suite-sha256 <approved-canonical-suite-sha256> \
  --hidden-public-key /secure/operator/hidden-verifier-public.pem \
  --hidden-private-key /secure/operator/hidden-verifier-private.pem \
  --hidden-nonce-store /secure/operator/hidden-nonces.json \
  --hidden-image-digest sha256:<approved-evaluator-image-digest>
```

On resume, the suite digest, evaluator image digest, protocol, and public-key digest must match the identity stored in the run archive. The suite path and key material are not written to the archive or copied into candidate snapshots. The nonce store must be durable across restarts; lock contention or malformed state fails closed. Do not pass `--hidden-eval`: command-based hidden evaluation remains unsupported.

The supervisor command-verification gate is separate from this signed hidden-result path. When `HEADLESSCODE_REQUIRED_VERIFICATION_COMMANDS_SHA256` is configured, every listed full command string must have a unique, correlated successful `execute_command` call/result pair in the session event log. That local event log is writable by the session and is not a signed external verifier result. Without an operator policy, historical result-only logs may count as legacy command activity, but they do not establish independent verification.
