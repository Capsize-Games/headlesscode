# RSI adversarial qualification

`scripts/rsi-adversarial-qualification.ts` runs one bounded OpenRouter Muse Contributor review against a synthetic candidate, then sends the reviewer-generated tests to the configured RSI fleet for evaluation in a separate OpenShell CPU guest. The candidate patch is a deterministic fixture; the command makes no mutation-model call and does not claim one. The normal RSI controller records the prompt, response, generated test, evaluation job, hard gate, penalty, and candidate decision.

The command requires `HEADLESSCODE_OPENROUTER_API_KEY`, the configured PostgreSQL/S3 RSI queue, and an active CPU-class OpenShell worker. It checks Muse endpoint metadata before the inference request, restricts routing to Meta with fallbacks disabled, limits the review to 1,024 output tokens and a conservative $0.005 call ceiling, and verifies the returned model, provider, and generation billing record. Endpoint metadata must remain at or below $0.10 per million input tokens and $0.20 per million output tokens.

The output directory must be private (mode `0700`). Supply an Ed25519 receipt key stored outside the repository with mode `0600` and its pinned public-key SHA-256 digest:

```sh
TMPDIR="$PWD/.headlesscode/scratch/tmp" npx tsx scripts/rsi-adversarial-qualification.ts \
  --receipt-signing-key "$QUALIFICATION_SIGNING_KEY" \
  --receipt-public-key-sha256 "$QUALIFICATION_PUBLIC_KEY_SHA256" \
  --artifacts-dir "$PWD/.headlesscode/scratch/rsi-adversarial-qualification/run-1"
```

The command writes the controller prompt, raw response, generated tests, OpenShell output, controller run and archive, and a signed `qualification-receipt.json`. The receipt binds artifact hashes to reviewer and billing identities, the independently reconstructed adversarial gate and selection decision, and the synthetic fixture mutation provenance. Verify its Ed25519 signature against the public key whose digest matches the receipt pin.

This is a one-review qualification run, not a mutation campaign or a benchmark proof. Development benchmarks are deliberately not admitted by this command, so an adversarial pass alone cannot select the candidate. If the reviewer finds a defect and its generated test fails, the controller should close the adversarial hard gate and reject the candidate. If the tests pass, the command records that result without claiming final selection eligibility.
