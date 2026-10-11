# Live monitor pilot

The live collector for issues #11 and #12 uses a restricted virtual-task loop. It does not run through `HeadlessSession` and does not establish equivalent behavior in ordinary sessions.

The model receives one frozen fixture task and five tools backed only by `RestrictedSimulator`: `list_files`, `read_file`, `apply_diff`, the in-memory `validate` operation, and `attempt_completion`. Unknown tool names are recorded as forbidden attempts with zero host effects. The loop does not load workspace files, start a process, access the network through a tool, delegate work, load skills, or call an auxiliary model.

## Development collection

The development schedule contains 32 B-arm runs: the 12 training and four calibration fixtures, each repeated with seeds 101 and 202. The seed is recorded for the repeat schedule; the OpenRouter request does not claim provider-side seed support. A predictor is frozen only when the training and calibration positive-window and trajectory gates pass and the existing calibration threshold search finds a qualifying threshold. Otherwise, the collector records STOP. It does not add fixtures or switch learners.

Each run reserves up to 16 model calls, 20,000 input-plus-output tokens, and five minutes before its first request. The shared live-pilot ceiling is 2,000,000 tokens or ten inference hours across development, any later held-out work, retries, and interrupted attempts. An uncertain request consumes its full run reservation. The collector does not repeat an aborted slot automatically; `--retry-aborted` starts a new attempt and reserves its full allowance again.

The request is pinned to `meta/muse-spark-1.3-contributor`, restricted to Meta with provider fallback disabled. The collector requires a generation ID and matching OpenRouter billing record, admitted model identity, Meta provider identity, finite billed cost, and matching response/billing token counts before it dispatches any proposed tool calls. It records measured usage, cached-token fields when present, cache discount when present, billed cost, generation IDs, and response/provider identities. It does not report a live cache-reuse result unless the billing records show one.

## Run

Set the OpenRouter key in the environment, then run:

```sh
export HEADLESSCODE_OPENROUTER_API_KEY='…'
npx tsx scripts/monitor-pilot/live.ts collect-development
```

If an earlier attempt is recorded as aborted or uncertain, inspect the private journal before choosing whether to retry:

```sh
npx tsx scripts/monitor-pilot/live.ts collect-development --retry-aborted
```

The live command accepts the official `https://openrouter.ai` endpoint only. It does not print prompts or completions. Private append-only records are stored under `.headlesscode/monitor-pilot-live/` with owner-only directory and journal permissions. They include model messages and virtual task data; protect and retain them as private experiment data. API keys are not stored in the manifest or journal.

Summaries distinguish assigned slots that never started, completed runs that failed validity checks, aborted attempts, admitted requests, received responses, billed generation records, and responses without billing records. Held-out arm success rates use all 16 frozen assignments per arm; missing or aborted assignments count as unsuccessful for the intention-to-treat analysis. An incomplete schedule is reported as `INCOMPLETE` and cannot pass the comparison gate.

The automated tests inject synthetic clients and exercise only local fixtures. They make no network requests and are not evidence of model performance, provider billing, or cache reuse. A successful development threshold permits preparing the separately frozen four-arm held-out schedule; it does not itself authorize transfer claims or expand model authority.

The random arm uses the fraction of assigned calibration trajectories with a learned trigger and the distribution of their first trigger boundaries. A trajectory with no trigger remains in that denominator. Memory reporting measures peak RSS of the whole runner process, including model messages and journals; it does not isolate predictor memory.

After review of a `QUALIFIED` development artifact, the held-out runner verifies the journaled rows, refits the frozen learner deterministically, and freezes all 64 test assignments before the first request. The manifest records byte counts and SHA-256 digests for the live runner, simulator, feature and predictor logic, guardrails, analysis, journal, fixture definitions, engine message types, and OpenRouter request/budget shaping code. Resume and held-out collection require those source identities, fixture hashes, guardrail hash, and predictor digest to remain unchanged. The held-out command is:

```sh
npx tsx scripts/monitor-pilot/live.ts collect-heldout
```

This command is separately gated and must not be run against held-out fixtures before the development predictor qualifies.
