# Hidden RSI verification

`src/rsi/evaluator.ts` accepts an optional `HiddenEvaluationOptions` value for
supervisor-owned exported-function cases. Each case names a candidate module
and export, gives bounded JSON input, and keeps the expected JSON output in the
supervisor process. The isolated runner receives only the case IDs, module and
export names, inputs, and frozen request identity. The supervisor compares
returned outputs with expected values after validating the signed report.

The protocol digest covers the complete declarative suite and resource limits.
Every request also binds the candidate's SHA-256 source-tree digest, commit,
session ID, job ID, and one-time nonce. A caller must provide a durable nonce
store and a pinned public verification key. The runner's signing key belongs
outside candidate execution. Missing isolation, malformed or unsigned reports,
replayed nonces, changed identities, incomplete cases, and out-of-bound data
fail closed. A returned case mismatch is a failed hidden check. Existing
protected-path, regression, typecheck, and curriculum proof gates continue to
apply.

An `IsolatedHiddenCaseRunner` implementation is a security boundary: it must
start fresh candidate execution under the supplied time and memory limits,
provide only the request inputs, return only bounded outputs, and never mount
the suite, expected outputs, signing key, or supervisor decision logic. The
generic API has no built-in fallback runner. Deployments without a runner that
meets this contract must leave hidden cases unavailable; arbitrary
`hiddenEvalCommands` remain refused.

For ordinary review and QA activity checks, operators can set
`HEADLESSCODE_REQUIRED_VERIFICATION_COMMANDS_SHA256` to a comma-separated list
of SHA-256 identities for exact required command strings. Compute an identity
as SHA-256 over the command's UTF-8 bytes, without trimming or shell
normalization. The event feed must contain a correlated `execute_command`
call and successful result with that identity for every configured command.
Unrelated successful commands do not satisfy the policy. With no configured
policy, the compatibility gate accepts any correlated successful command as
`legacy-command-activity-only`; this is activity evidence, not independent
verification. The ordinary local event feed is writable by the session and
does not provide the signed external-verifier guarantees above.
