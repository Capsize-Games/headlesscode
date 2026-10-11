# Muse cache qualification

HeadlessCode builds each session's system prompt once and keeps it at the start of later model requests. It sends an opaque random `session_id` and `prompt_cache_key` on OpenRouter chat requests. The value is created per run and reused across that run's calls; it is not derived from prompt text, account data, a workspace path, or an API credential. OpenRouter documents `session_id` as a sticky provider-routing key (up to 256 characters) and documents prompt-cache usage in `usage.prompt_tokens_details`. A routing key can improve provider affinity, but it does not guarantee that a provider cache will hit. [OpenRouter prompt-caching guide](https://openrouter.ai/docs/guides/best-practices/prompt-caching)

Meta documents cache reuse for matching leading token sequences and the optional `prompt_cache_key` affinity field. The qualification script puts its fixed synthetic data in one unchanged system message and varies only the final user message. [Meta prompt-caching guide](https://dev.meta.ai/docs/prompt-caching)

The supported audit targets `meta/muse-spark-1.3-contributor`. OpenRouter's endpoint metadata lists Meta as its serving provider and reports $0.10 per million input tokens, $0.20 per million output tokens, and $0.002 per million cache-read tokens (retrieved 2026-10-10). The checked-in table uses these rates for the budget guardrail; it does not represent an invoice or claim a cache hit. [OpenRouter Muse endpoint and pricing](https://openrouter.ai/meta/muse-spark-1.3-contributor)

## Running the audit

Review `scripts/qualify-muse-cache.ts`, then run from the repository root:

```sh
npx tsx scripts/qualify-muse-cache.ts --confirm-live
```

This opt-in command sends at most four streamed requests through HeadlessCode's `OpenRouterClient`, pinned to Meta with fallbacks disabled. It allows at most 32 output tokens per request and a 25-second per-call timeout. The complete run has a 120-second timeout and refuses the workload if the conservative preflight estimate exceeds $0.02. That estimate prices every input character as a token at the live full input rate, includes the output cap, uses no cache discount, then doubles the result. It is a local safety estimate, not provider billing evidence. The script requires an active Meta endpoint and valid live endpoint prices before making an inference request.

The fixed synthetic prefix is repeated exactly within one run and includes an opaque per-run nonce to prevent an earlier audit's prefix from warming the first request. Each request changes only a short synthetic question. The script never prints prompt text or the API key. It refuses to run when transcript capture is enabled, and stops issuing requests after a failed call or missing authoritative billing record because a timed-out request could still have incurred a charge. It reports per-call model/provider identifiers, streamed token usage, cache tokens, generation IDs, latency, the response-reported cost, and the separate OpenRouter generation-record billing fields. A generation metadata lookup retries briefly if OpenRouter has not made the billing record available yet. Missing or malformed billing evidence is never replaced by the guardrail estimate.

The output is JSON on stdout. Save it only to a location approved for synthetic service metadata; it contains no prompt body. Response/stream identity and generation-record identity are captured in separate fields. Both must match an explicit allowlist containing the requested Muse slug and OpenRouter's dated canonical alias `meta/muse-spark-1.3-contributor-20260902`; the audit does not accept arbitrary model-name prefixes. It exits nonzero unless all four calls have a finite generation-record `total_cost`, both identities report Meta, and at least one later request reports cached prompt tokens. Generation-record lookups retry with increasing delays because that record can appear after the streamed response. Cache hits are provider- and timing-dependent, so a zero cached-token count is a failed qualification observation rather than proof that caching is unsupported.

## Observed qualification

The live audit passed on 2026-10-10. All four responses identified Meta and the requested Muse Contributor model; the corresponding OpenRouter generation records identified Meta and the allowlisted dated model. Each request used the same synthetic prefix and allowed 32 output tokens.

| Request | Prompt tokens | Cached prompt tokens | OpenRouter generation-record cost (USD) |
| --- | ---: | ---: | ---: |
| Cold | 2,798 | 0 | 0.000286200 |
| Warm 1 | 2,797 | 2,673 | 0.000024146 |
| Warm 2 | 2,798 | 2,673 | 0.000024246 |
| Warm 3 | 2,797 | 2,673 | 0.000024146 |

The four calls cost $0.000358738 in total. The warm requests reused about 96% of their input tokens. These observations qualify repeated-prefix caching through the client; cache reuse in a different workload must be checked from that workload's usage and billing records.
