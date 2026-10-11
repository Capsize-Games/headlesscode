# Recursive Self-Improvement

`headlesscode improve --dry-run` plans candidate worktrees. A real run requires
a PostgreSQL queue, a shared S3-compatible artifact store, and at least one
registered `headlesscode rsi-worker` connected to an OpenShell gateway. The
coordinator queues a sanitized baseline visible evaluation, candidate mutation
snapshots, and candidate visible evaluations; workers run each job in a fresh
OpenShell guest. The coordinator applies returned patches, calculates fitness,
compares results with the baseline, and owns the archive and candidate
selection. Full visible-test output is content-addressed in the object store;
PostgreSQL keeps bounded previews and artifact references. Hidden evaluation
remains disabled.

## Candidate guest isolation check

RSI evaluation workers receive a one-commit sanitized snapshot at `/workspace`
and a separate writable `/result` export directory. The RSI evaluation profile
does not add project-data, shared-data, checkpoint, memory, or arbitrary
read-only mounts. Its network policy is empty. Candidate mutation and
evaluation processes run in separate disposable guests; candidate mutation
snapshots omit RSI policy, evaluator and scoring files, tests, and operator
data. Evaluation guests receive only the configured visible evaluation inputs
and fixed verifier files needed for that evaluation. The coordinator keeps the
archive, host worktree, process-control state, evaluator configuration, and
scoring logic on the host. A candidate can change its own snapshot and its
Git metadata; returned changes are checked before host import.

Run `npm run rsi:security-canary` from the repository root to qualify synthetic
host-path and snapshot behavior against the selected OpenShell gateway and the
RSI image enforced by the provider. The command creates a disposable synthetic
repository, starts an evaluation guest without model inference, attempts reads
and writes against synthetic host, control, evaluator, scoring, archive, and
Git metadata canaries, checks that those host canaries remain absent or
unchanged from the guest's attempted writes, checks an intended `/workspace`
write, and records paths plus guest error codes under `.headlesscode/scratch/`.
The guest may also have other writable locations such as `/tmp`; this check
does not claim that `/workspace` is its only writable location. A pass is
specific to the gateway and image used for that run; mocked provider tests are
not a substitute for this guest check.

## Evaluator integrity seals

Paired worker-harness, hidden-evaluator, and adversarial qualification runs
require an Ed25519 evaluator signing key, an independently configured trusted
public key, and its `sha256:<hex>` DER-SPKI pin. Pass them with
`--evaluator-signing-key`, `--evaluator-trusted-public-key`, and
`--evaluator-trusted-key-sha256`. Both key files must be regular files with
mode `0600` or stricter and remain outside the repository, RSI archive, and
candidate worktree. The public key and pin must come from the operator's trust
configuration; the run does not establish its own trust.

The seal binds the evaluator source and runtime inputs, base tree, effective
commands and settings, evaluation output identities, and generation decisions.
The manifest is signed before each archive checkpoint that updates this state.
Resume verifies the independent pin and sealed archive state before dispatching
more work or accepting a selection. A changed source, trust key, output, or
selection fails closed. Historical records without a seal remain explicitly
unsealed; they cannot be retroactively sealed, and attested runs cannot resume
from an unsealed record. Ordinary runs without configured trust are reported
as unsealed.

## Earlier bounded runs (historical)

Before the fail-closed mutation runner was added, RSI ran bounded local Qwen
experiments through Ollama. The records documented for 2026-09-20 are
`rsi-20260920091313-78f3e206` (the worker reached its eight-iteration cap) and
`rsi-20260920025005-b0ef3ddf` (both workers reached the 20-iteration cap).
Neither run selected a candidate. These are historical results from an earlier
implementation and do not describe current `headlesscode improve` behavior.

The phase-one audit found four constraints that shaped phase two: candidate
execution was sequential, `--max-concurrent` was only parsed, the archive was
written at the end of a run with no checkpoint/resume state, and the next
generation followed only one scalar champion. Hidden commands were not shown in
the mutation prompt, but their tracked scripts were still physically present
in candidate worktrees.

## Current implementation and tested limits

The current extension adds archive v2 migration and active-run checkpoints,
resume support, explicit champion/specialist/novelty and Pareto parent policies,
raw multi-objective metric vectors, mutation hypotheses and classes,
resource-tagged experiment jobs, model-candidate and harness/model-combination
records, structured transcript-backed trajectory exports, and deterministic
curriculum proposals from recurring failures. The fleet queue stores worker
registrations, capacity policy, leases, fencing tokens, retries, and job
results in PostgreSQL. Snapshot and patch bytes live in a shared S3-compatible
object store; PostgreSQL keeps only content digests and object references.
Each worker process registers one configured gateway and runs one guest at a
time. Multiple explicitly configured workers can claim jobs across gateways;
there is no automatic gateway discovery.

Queue integration tests ran against disposable local PostgreSQL and RustFS
services: 12 simulated worker identities contended for 100 queued jobs,
exercised admission caps, and transferred a 20 MiB artifact. Four jobs first
verified the initial admission cap; the remaining 96 were then drained
concurrently. OpenShell mutation tests use
a fake provider for isolation checks. A prior bounded local OpenShell run
passed its visible checks but made no source change and was rejected. A
2026-09-29 bounded two-candidate controller run completed against a temporary
`clamp.js` fixture. The baseline passed 1/2 visible/regression trials; both
candidates passed 2/2 and returned the same 764-byte patch. Two worker
identities on the same `rsi-local` gateway held the candidate evaluation
leases concurrently for an observed 4.008 seconds. This demonstrates
controller fan-out and same-gateway OpenShell execution only; it does not
qualify multiple gateways or hosts. At the time, `openshell gateway list`
showed `rsi-local` reachable and `headlesscode-local` at
`http://127.0.0.1:18080`; a TCP connection to that endpoint was refused, so no
second live gateway was available. The fixture result does not establish
general harness improvement. Hidden evaluation was not measured. One mutation
attempt was retried; the saved error truncates
before its terminal cause. The adversarial role and OpenShell break-test path
are implemented but have not been exercised with a live review provider.

The opt-in `adaptive-independent` compute policy evaluates the initial
population independently, then admits at most one follow-up candidate when
that cohort has mixed statuses or visible pass rates. This version requires
`--generations 1` and limits `--max-trajectories` to the initial population plus
one. The archive and report record the evidence, decision, allocation,
remaining budgets, and stop reason. `--max-trajectories` defaults to population
plus one, `--max-total-iterations` defaults to the per-candidate iteration cap
multiplied by the trajectory cap, and `--max-runtime-ms` defaults to one hour.
These budgets must cover the initial population. `--max-concurrent` sets queue
admission capacity. Runtime is checked before admitting a follow-up; it does
not terminate a job already running. Iterations are a bounded model-call proxy
for the local worker, not a dollar-cost estimate.

## Bounded run sequence

1. Resolve a base commit and queue a sanitized baseline visible evaluation to
   an OpenShell worker before scoring it in the coordinator.
2. Create a small population of candidate worktrees and one-commit mutation
   snapshots that omit RSI policy, evaluator suites, tests, credentials, and
   operator data; enqueue one idempotent job per candidate.
3. Workers claim jobs with expiring fenced leases, run the mutation in a fresh
   OpenShell guest, and return a patch through the object store. The coordinator
   validates and applies the patch before evaluation.
4. Enqueue visible evaluation jobs with separate sanitized snapshots. Each
   evaluation command runs in a fresh OpenShell guest. Complete stdout and
   stderr content is stored as a content-addressed object; PostgreSQL holds
   bounded previews and references. Hidden evaluations are
   unavailable because their evaluator assets do not yet have a separate
   trusted service boundary.
5. The coordinator runs regression, typecheck, and visible evaluation gates,
   then obtains the fixed-harness development benchmark for the candidate, its
   exact immediate parent, and the run base. It selects only candidates with
   comparable verified evidence that pass the frozen development rule and all
   evaluator gates, then writes the archive and report.

## Self-hosted worker harness experiments

`--worker-harness-mode fixed-control|self-hosted` selects the worker code used
for mutation jobs. Generation zero uses the pinned runtime harness in both
modes. Fixed-control executes `/opt/headlesscode/src/cli.ts`. Self-hosted
generations after zero execute `/workspace/src/cli.ts` from the selected
parent's sanitized source snapshot. Both use the runtime image's read-only
`/opt/headlesscode/node_modules` and TypeScript configuration.

Before admitting a mutation, the coordinator checks that the selected parent
descends from the run base and that its complete base-to-parent tree change
contains no protected paths. The hard-protected set includes RSI policy, tests
and evaluators, fixture corpora, package metadata, Docker build inputs, and
supervisor state, even if a caller supplies an incomplete protected-path list.
The worker receives a one-commit sanitized snapshot with those paths omitted.
Its tree digest is checked before OpenShell provider creation. The runtime
image digest, embedded harness commit, dependency-lock digest, selected parent
commit, snapshot commit and tree digest, mode, and executed CLI path are stored
with the mutation result before evaluation or promotion.

Use the same `--worker-harness-pair-id`, task, base commit, model/provider,
seed, population, iteration and token ceilings, timeout, and evaluation
settings in both runs. The coordinator freezes a config digest and rejects a
second arm with different settings or runtime identity. Candidate IDs remain
distinct between arms. Pairing records the configured experiment seed; the
current code worker uses temperature zero, while the seed does not create a
provider-side random seed parameter.

```mermaid
flowchart LR
  C[Coordinator] --> P[Validate selected parent and protected tree]
  P --> S[Create sanitized one-commit snapshot and digest]
  S --> G[OpenShell guest]
  G -->|fixed-control| F[/opt/headlesscode/src/cli.ts]
  G -->|self-hosted after generation zero| W[/workspace/src/cli.ts]
  F --> D[Read-only runtime dependencies]
  W --> D
  G --> I[Return patch and execution identity]
  I --> V[Validate and import outside guest]
  V --> E[Independent evaluation and promotion]
  X[RSI policy, tests, evaluators, confirmation fixtures] -. omitted .-> G
```

`scripts/rsi-benchmark/self-hosted-harness-smoke.ts` is a bounded integration
probe for this path. It creates a prompt sentinel in generation zero, records
the same parent marker in generation one, then observes the real model request
in generation two. Only the self-hosted workspace CLI should include the
sentinel in that request; the fixed-control CLI remains pinned to the image.
The mock upstream returns deterministic, different tool edits for those two
generation-two requests. Each task allows three calls, 256 output tokens per
call, and a 180-second job timeout. The probe uses no production provider
credential and requires an exact image built from a clean commit.

Earlier bounded runs used the locally installed `wxrq-qwen3.5-9b:latest` model
through Ollama before the fleet adapter existed. In the current setup,
AirunnerDesktop's LLM worker exposes the local Qwen GGUF through its
Ollama-compatible endpoint. Current fleet workers call that endpoint using the
configured model ID; mutation and visible evaluation jobs are dispatched
through PostgreSQL and S3-compatible storage. This is inference through the
Airunner worker, not GGUF fine-tuning.

## Usage

```sh
npx tsx src/cli.ts improve --repo . --dry-run
npx tsx src/cli.ts improve --repo . --population 2 --generations 1
```

### Build the RSI guest image

On each host whose OpenShell gateway will execute RSI jobs, build the standard
and RSI guest images. The RSI Dockerfile extends the standard image, so build
that base image first. Build the larger training derivative only on gateways
whose workers will accept model-training or paired model-evaluation jobs:

```sh
docker build -f docker/OpenShell.Dockerfile -t headlesscode-openshell:local .
docker build -f docker/OpenShell-RSI.Dockerfile -t headlesscode-openshell-rsi:local .
docker build -f docker/OpenShell-RSI-Training.Dockerfile -t headlesscode-openshell-rsi-training:local .
```

`docker/OpenShell-RSI.Dockerfile` uses `FROM headlesscode-openshell:local` and
adds the RSI guest's Python runtime while removing the RSI source, test files,
and hidden evaluation suite. RSI execution requires the resulting
`headlesscode-openshell-rsi:local` image; custom images are rejected until
their contents are verified.

The training image extends `headlesscode-openshell-rsi:local`. Its Python
dependencies are installed from `scripts/rsi-training/requirements.lock` with
hash checking; direct versions and transitive hashes were resolved on
2026-09-28. The image build rejects a CPU-only PyTorch wheel. Training also
checks `torch.cuda.is_available()` inside the guest before it starts.

The npm package does not include the Dockerfiles, training scripts, fixtures,
or test runner needed by this workflow. Build and run RSI workers from a source
checkout.

The default archive is `.headlesscode/rsi/archive.json`; generation reports are
written beside it. Dry runs resolve the base commit and print planned
candidates without creating worktrees or writing the archive. For real runs,
configure `HEADLESSCODE_RSI_DATABASE_URL`, S3 artifact-store settings, and at
least one worker. Start each worker process with a unique
`HEADLESSCODE_RSI_WORKER_ID` and explicit `HEADLESSCODE_RSI_GATEWAY_ID`; the
worker sets that OpenShell gateway before running its preflight. Worker
processes currently run one job at a time, so add another process and unique
worker ID for each additional slot.

### Fleet configuration

Set these values on the coordinator and every worker. All processes in one
queue must use the same queue policy and artifact-store identity.

| Variable | Default | Use |
| --- | --- | --- |
| `HEADLESSCODE_RSI_DATABASE_URL` | Required | PostgreSQL connection for queue state and worker leases. |
| `HEADLESSCODE_RSI_QUEUE_NAME` | `rsi-default` | Shared queue identifier. |
| `HEADLESSCODE_RSI_MAX_IN_FLIGHT` | `1` | Queue-wide admission cap on workers; match `--max-concurrent` on `improve`. |
| `HEADLESSCODE_RSI_LEASE_MS` | `3600000` | Minimum lease duration. Jobs expand this from their timeout and visible-command count. |
| `HEADLESSCODE_RSI_MAX_ATTEMPTS` | `2` | Maximum attempts before a job becomes failed. |
| `HEADLESSCODE_RSI_CLASS_CAPACITY` | Empty map | Optional JSON map of resource-class admission caps. |
| `HEADLESSCODE_RSI_KEY_CAPACITY` | Empty map | Optional JSON map of concurrency-key admission caps. |
| `HEADLESSCODE_RSI_ARTIFACT_BACKEND` | `s3` | Fleet jobs require shared S3-compatible storage; `file` is same-host development only. |
| `HEADLESSCODE_RSI_ARTIFACT_BUCKET` | Required | Bucket shared by coordinators and workers. |
| `HEADLESSCODE_RSI_ARTIFACT_ENDPOINT` | AWS S3 | Optional S3-compatible endpoint. |
| `HEADLESSCODE_RSI_ARTIFACT_REGION` | `us-east-1` | S3 region. |
| `HEADLESSCODE_RSI_ARTIFACT_PATH_STYLE` | `0` | Set to `1` for path-style endpoint addressing. |
| `HEADLESSCODE_RSI_ARTIFACT_PREFIX` | `headlesscode/rsi` | Object key prefix. |
| `HEADLESSCODE_RSI_MAX_ARTIFACT_BYTES` | `536870912` | Maximum bytes per artifact (512 MiB). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS SDK credentials | Credentials for the shared artifact bucket; keep them in host processes. |
| `HEADLESSCODE_RSI_WORKER_ID` | Required on worker | Unique worker process identity. |
| `HEADLESSCODE_RSI_GATEWAY_ID` | Required on worker | Configured OpenShell gateway alias selected by this worker. |
| `HEADLESSCODE_RSI_WORKER_MAX_ACTIVE` | `1` | Must remain `1`; one process runs one guest at a time. |
| `HEADLESSCODE_RSI_WORKER_RESOURCE_CLASSES` | `LOCAL_GPU,CPU` | Comma-separated queue resource classes this process accepts. |
| `HEADLESSCODE_RSI_BASE_MODEL_PATH` | Required on coordinator and model workers | Local Hugging Face checkpoint directory copied outside the guest workspace and attached as a separate Docker `read_only` bind; symlinks/special files are rejected, with 64 GiB and 100,000-file bounds. A `.gguf` path or GGUF model identity is rejected before admission. |
| `HEADLESSCODE_RSI_BASE_MODEL_ID` | Required on coordinator running `rsi-train-model` | Operator-supplied checkpoint identity/revision recorded with results; workers receive it in each job payload. |
| `HEADLESSCODE_RSI_WORKER_SCRATCH_DIR` | System temp `headlesscode-rsi-worker` | Private local scratch for downloaded snapshots. |
| `HEADLESSCODE_RSI_WORKER_POLL_MS` | `1000` | Delay between empty queue polls. |
| `HEADLESSCODE_OPENSHELL_POLICY` | Required | Base OpenShell policy YAML. |
| `HEADLESSCODE_OPENSHELL_IMAGE` | `headlesscode-openshell-rsi:local` | RSI guest image; custom images are rejected. |
| `HEADLESSCODE_RSI_OLLAMA_HOST` | `host.openshell.internal` | Local Ollama host permitted by the RSI mutation policy. |

### OpenRouter mutation and development-proof jobs

OpenRouter is available for RSI fleet mutations and the development benchmark
when the worker role is configured with
`HEADLESSCODE_RSI_ROLE_WORKER_PROVIDER=openrouter` and
`HEADLESSCODE_RSI_ROLE_WORKER_MODEL=deepseek/deepseek-v4-flash-0731`. The model
is routed through OpenRouter's available DeepInfra fp8 endpoint
(`deepinfra/fp8`) with fallback routing disabled. The broker checks endpoint
metadata and requires the returned selected-provider metadata to identify
DeepInfra before qualifying usage.

The worker can instead use the supervisor-owned Muse Spark Contributor profile
by setting `HEADLESSCODE_RSI_ROLE_WORKER_PROVIDER=openrouter`,
`HEADLESSCODE_RSI_ROLE_WORKER_MODEL=meta/muse-spark-1.3-contributor`, and
`HEADLESSCODE_RSI_ROLE_WORKER_OPENROUTER_PROFILE=muse-spark-contributor`.
That profile admits the Meta `meta` endpoint with the advertised `unknown`
quantization and disables fallback routing. Before dispatch, the broker fetches
current endpoint metadata and rejects unavailable endpoints, missing tool
parameters, or rates above the configured input and output price ceilings.
The worker must report the exact admitted model and Meta provider identity,
measured usage, and cost for a qualified receipt. The broker sets the same
random, job-scoped opaque value as OpenRouter's `session_id` and
`prompt_cache_key` on each call in the job; guest-supplied cache hints are
ignored. This lets repeated calls in a job use provider prompt caching without
using campaign or job identifiers as cache keys. This configuration describes
broker admission and accounting; it does not establish a live RSI result.

Include `REMOTE_API` in `HEADLESSCODE_RSI_WORKER_RESOURCE_CLASSES` for workers
that claim brokered calls; Ollama workers continue to claim `LOCAL_GPU`.
Workers need the host-side `HEADLESSCODE_OPENROUTER_API_KEY` and
`HEADLESSCODE_RSI_BROKER_BIND_HOST`; the bind address must be assigned in the
worker process's network namespace and reachable from the OpenShell guest. The
key remains in the worker process. Guests receive a job-scoped capability for
a host broker, and their OpenShell network rule admits only that broker
endpoint. With the local Docker gateway, `host.openshell.internal` resolves
inside the gateway network namespace. Run the worker in that namespace and
bind the broker to the gateway container's address; a host-side bind to the
Docker bridge gateway address is not reachable from this route. Keep the
worker's PID and mount namespaces on the host; only its network namespace
needs to match the gateway.

Set explicit price and spend ceilings on the coordinator and workers:

| Variable | Use |
| --- | --- |
| `HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD` | Maximum admitted input-token price; broker checks the pinned endpoint price before serving a job. |
| `HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD` | Maximum admitted output-token price. |
| `HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD` | Worst-case reservation for one call; must cover the configured per-call token ceilings at the price ceilings. |
| `HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD` | Maximum reserved and settled spend for one job. |
| `HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD` | Operator's total inference ceiling for mutation and benchmark work. |
| `HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD` | Portion allocated to mutation jobs. |
| `HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD` | Portion allocated to development benchmark jobs. |

The mutation and benchmark allocations are rounded conservatively and must
sum to no more than the total campaign ceiling. Keep all three values fixed
for a run. Configure the job spend ceiling no higher than either allocation;
the broker rejects a job cap that exceeds its branch's campaign allocation.
The broker also accepts finite call, input-token, output-token,
total-token, duration, and request/response-byte limits through the
`HEADLESSCODE_RSI_OPENROUTER_MAX_*` variables. The duration deadline starts
when the broker registers the job, before guest provisioning and execution, so
setup time counts against the attempt bound. If a response has missing or
ambiguous usage, the reservation stays charged and that job cannot qualify;
the broker does not retry an ambiguous paid dispatch. Attempt receipts record
the requested and returned model, token counts, provider cost, response digest,
and authenticated denial counts grouped by status and reason. Denial summaries
contain no request body or credential data; unauthenticated requests are not
attributed to a job. Attempt receipts and RSI reports preserve these summaries;
failed fleet mutations retain only the denial summary with accounting marked
incomplete. Guest transcript counts remain observational and do not qualify
proof.

The same-host development benchmark uses a file-backed spend ledger. A process
crash can leave its exclusive ledger lock in place; the next run fails closed
and requires an operator to inspect the ledger and remove a stale lock. Fleet
mutation reservations use PostgreSQL instead. Configure the database migration
before scheduling brokered fleet work.

Restart-safe paired proof campaigns freeze every planned generation in the
manifest. They reject the `adaptive-independent` policy before campaign
admission because an early stop would leave scheduled generations unmeasured.
Use a fixed generation count for these campaigns.

The proof manifest stores the digest of the complete benchmark manifest,
including runner/version metadata, plus separate development and confirmation
task digests. It also freezes the final-generation confirmation cells for every
candidate slot and a root-control comparison in each arm. Mutation and
benchmark inference use distinct broker campaign IDs derived from the shared
proof campaign ID, so their allocation caps remain separate while their
reservations count against the one PostgreSQL proof-campaign root ceiling.

The demonstration launcher separates engineering from holdout planning. The
engineering run freezes development-only cells and runs both arms for two
generations. It must record an accepted generation-zero self-hosted candidate
and an accepted generation-one child whose worker execution used that exact
parent commit. The fixed-control arm must also reach a terminal generation-one
decision. Only after these checks pass may the operator create the final plan;
that plan binds the engineering evidence and freezes the three confirmation
campaigns. Engineering-only manifests contain no confirmation task IDs or
confirmation schedule cells.

Use the staged commands below from a clean checkout with the exact fixed and
self-hosted harness image identities configured. Estimate and plan fetch only
the pinned endpoint's read-only price metadata. Execution requires PostgreSQL,
OpenShell, the broker, the model key on the supervisor, finite per-role
allocations, and a separately reviewed operator cap. No production inference
has been run as part of this implementation.

```sh
# Review the engineering-only schedule and live price before choosing a cap.
npm run rsi:proof-demonstration -- engineering --repo "$PWD" --seed "$ENGINEERING_SEED"

# Run the two-generation engineering pair. The cap must cover this root's
# frozen reservation and fit the configured mutation + benchmark allocations.
npm run rsi:proof-demonstration -- engineering --repo "$PWD" --seed "$ENGINEERING_SEED" \
  --operator-cap-usd "$ENGINEERING_CAP_USD" --execute

# Freeze three new campaign seeds only after the engineering evidence passes.
npm run rsi:proof-demonstration -- plan --repo "$PWD" \
  --engineering-evidence .headlesscode/rsi-proof/engineering-evidence.json \
  --operator-cap-usd "$CAMPAIGN_CAP_USD" --seed "$ENGINEERING_SEED" \
  --campaign-seed "$CAMPAIGN_SEED_A" --campaign-seed "$CAMPAIGN_SEED_B" \
  --campaign-seed "$CAMPAIGN_SEED_C" --out .headlesscode/rsi-proof/frozen-plan.json

# Verify the frozen identities and cap, execute all three paired development
# and confirmation campaigns, then write JSON and Markdown analysis reports.
npm run rsi:proof-demonstration -- verify --repo "$PWD" --plan .headlesscode/rsi-proof/frozen-plan.json
npm run rsi:proof-demonstration -- execute --repo "$PWD" --plan .headlesscode/rsi-proof/frozen-plan.json \
  --operator-cap-usd "$CAMPAIGN_CAP_USD" --execute
npm run rsi:proof-demonstration -- analyze --repo "$PWD" --plan .headlesscode/rsi-proof/frozen-plan.json \
  --archive .headlesscode/rsi
```

The engineering command binds each campaign arm to a deterministic
campaign-and-arm run ID. A restart reuses a finished arm's verified archive
record or resumes the same active identity; an archived incomplete arm is
rejected. Final campaign execution likewise reuses terminal arm records and
will not dispatch a second attempt for an already completed cell. A crash
after broker dispatch but before a verified result artifact remains uncertain
and fails closed under the PostgreSQL ledger; it is not retried automatically.
Each final campaign's cap is checked against its frozen root reservation, and
the command's supplied cap must exactly match the value in the plan. The
engineering cap is separate from the final plan's cap for the three campaigns.

Analysis verifies the three paired terminal campaign records, frozen
manifest/config/model/runtime identities, each confirmation schedule cell,
the selected-parent lineage, broker receipts, artifact digests, and PostgreSQL
root accounting. Missing, unqualified, or altered evidence yields
`inconclusive`; a completed set that misses the frozen improvement gates yields
`not-demonstrated`. A demonstration verdict is not a release or promotion
action.

To exercise the worker image and guest network boundary without a production
provider credential or paid request, build the exact current harness image
from a clean checkout, then run the bounded mock-upstream smoke. This local
Docker gateway recipe obtains the gateway PID and address at runtime. It uses
the existing `rsi-local` mTLS client bundle through a temporary endpoint alias;
the trap removes that alias when the smoke exits:

```sh
npx tsx scripts/rsi-benchmark/build-image.mjs "$(git rev-parse HEAD)" --commit-context
gateway_container=openshell-rsi-gateway
gateway_pid=$(docker inspect --format '{{.State.Pid}}' "$gateway_container")
gateway_ip=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$gateway_container")
gateway_alias=${OPENSHELL_GATEWAY:-rsi-local}
gateway_config="$HOME/.config/openshell/gateways"
endpoint_alias="$gateway_config/https___127.0.0.1_18080"
test ! -e "$endpoint_alias" && test ! -L "$endpoint_alias"
ln -s "$gateway_config/$gateway_alias" "$endpoint_alias"
trap 'unlink "$endpoint_alias"' EXIT
sudo -n nsenter -t "$gateway_pid" -n -- runuser -u "$(id -un)" -- env \
  OPENSHELL_GATEWAY_ENDPOINT=https://127.0.0.1:18080 \
  HEADLESSCODE_RSI_BROKER_BIND_HOST="$gateway_ip" \
  npx tsx scripts/rsi-benchmark/mock-openrouter-guest-smoke.ts .
sudo -n nsenter -t "$gateway_pid" -n -- runuser -u "$(id -un)" -- env \
  OPENSHELL_GATEWAY_ENDPOINT=https://127.0.0.1:18080 \
  HEADLESSCODE_RSI_BROKER_BIND_HOST="$gateway_ip" \
  npx tsx scripts/rsi-benchmark/self-hosted-harness-smoke.ts .
```

The `openshell-rsi-gateway` container name and `rsi-local` alias must match the
local installation. This smoke makes at most three brokered calls to an
in-process mock upstream, checks the host credential stays out of the guest
result, and requires a guest request to a second live local HTTP sentinel on a
port outside the broker allowlist to fail without reaching it. It verifies
the mock route and network boundary only; it is not model improvement evidence
or a live OpenRouter result. A long-running local worker must likewise start
in the gateway network namespace (or use another specifically tested,
gateway-reachable interface), set `OPENSHELL_GATEWAY_ENDPOINT` to its mTLS
gateway endpoint, and bind the broker on an address reachable through that
namespace. Do not expose the broker on wildcard or unrelated host interfaces.

The second command runs three generations in each of two paired arms (six
mutation attempts total), capped at three mock calls per attempt. It checks that the
generation-zero prompt edit reaches the generation-two self-hosted request,
that the fixed-control request remains unchanged, and that the mock model
returns different generation-two task edits. It uses only a local mock
upstream and does not provide model-improvement evidence.

Run `headlesscode rsi-worker` once per worker identity. It sets
`OPENSHELL_GATEWAY` from `HEADLESSCODE_RSI_GATEWAY_ID` before preflight.
Database and object-store credentials stay in host processes and are not sent
to candidate guests.

### Model-training prototype and GGUF support boundary

The bounded model command requires an existing RSI run in the archive, a
shared PostgreSQL/S3 queue, a fresh worker advertising `TRAINING_GPU`, and a
CPU worker for paired evaluation. The prototype's training script expects a
local Hugging Face checkpoint directory; model workers need the training image,
`HEADLESSCODE_RSI_WORKER_RESOURCE_CLASSES=TRAINING_GPU,CPU`, and the local
checkpoint path above. The training job requests one OpenShell GPU. Paired
inference runs on CPU and fails closed when the checkpoint exceeds 2 GiB. For
a finished run, invoke:

The OpenShell Docker gateway must allow caller driver configuration and host
bind mounts for the checkpoint mount. A gateway administrator must enable
`allow_driver_config = true` and `enable_bind_mounts = true` in its Docker
driver configuration and disable Docker resource admission for that driver.
Host bind mounts expose gateway-host files inside guests; restrict gateway
administration and use only the RSI provider's bounded read-only checkpoint
mount. See NVIDIA's [gateway configuration reference](https://docs.nvidia.com/openshell/latest/reference/gateway-config)
and [Docker driver mount guidance](https://docs.nvidia.com/openshell/latest/reference/sandbox-compute-drivers).

```sh
npx tsx src/cli.ts rsi-train-model --repo . --archive-dir .headlesscode/rsi \
  --resume <run-id> --model-candidate-id <candidate-id> \
  --model <worker-model> --base-ref <run-base-ref>
```

The prototype dataset has three reference solutions from registered curriculum
fixtures. Its intended HF-checkpoint path uses NF4 with double quantization,
rank 8, alpha 16, dropout 0.05, fixed seed 1337, and eight optimizer steps. It
does not use collected agent trajectories. The held-out fixture contains three
task/input cells; the base checkpoint and adapter are intended to run those
same cells in separate OpenShell jobs with greedy decoding and a 256 new-token
maximum. The metric is the fraction of outputs exactly matching normalized
reference solution text. This fixture is a smoke comparison, not evidence of
general improvement or performance on the full headlesscode harness.

The base checkpoint is copied for each OpenShell job. This adds storage and
startup cost; no gateway-side immutable checkpoint cache has been implemented
or qualified. The supervisor records dataset and model digests, training
job/result, adapter artifact reference, and each paired result. Failed or
partial training, an artifact digest mismatch, an incomplete cell set, or a
base-checkpoint mismatch leaves the candidate ineligible. Eligibility requires
all eight training steps and complete results from both models; the adapter
must score higher than the base on the exact-match metric. These checks are
exercised with mocked job results; no successful training or paired model
evaluation has been run with real weights.

The operator-supplied `Qwen3.5-9B-Q8_0.gguf` is not supported by this QLoRA
prototype. The command requires `HEADLESSCODE_RSI_BASE_MODEL_PATH` on the
coordinator and workers, and rejects a `.gguf` path or model identity before
checking worker capacity or enqueueing work. In the built training image,
Transformers 5.17 rejects combining GGUF loading with bitsandbytes
quantization. Its non-quantized loader reports no GGUF CUDA matmul kernel for
the RTX 5080 and
attempts to dequantize the full model, which exceeds the available 16 GiB GPU
memory. No training was started. Airunner's authenticated OpenAI-compatible
chat API returned 401 without a credential, and its chat request contract has
no adapter selector; RSI does not pass credentials or claim this as an adapter
evaluator. The AirunnerDesktop Ollama-compatible worker remains the supported
inference route for mutation, but it does not provide the paired base/adapter
training path.

The 10.1 GiB training image was built and its CUDA-enabled PyTorch wheel was
verified. The repository-checkout scripts and fixture files needed to build
the RSI images and run the model prototype are not included in the npm package;
build and run this workflow from a source checkout. A disposable local PostgreSQL/RustFS load
test first claimed and completed four jobs to verify admission, then drained
the remaining 96 jobs with 12 simulated workers in 446 ms (215.2 jobs/s), with
two overlapping jobs under a configured cap of four. Claims still lock one
queue-policy row to enforce global admission; this same-host measurement is a
functional benchmark, not a multi-host throughput guarantee.

## Fitness and safety

Regression, typecheck, completion, absence of a crash, protected-path
integrity, and configured visible evaluations are hard gates. Empty visible or
hidden suites are unmeasured; they do not contribute a perfect score. Hidden
and confirmation evidence is currently unmeasured. The score uses only measured
components. A candidate that fails a hard gate cannot be selected even when
its partial score is high.

Development-proof decisions use a protocol frozen into the run archive. The
protocol pins the development task identities and verifiers, model and sampling
settings, per-task ceilings, and rule. The coordinator compares each candidate
with its exact immediate parent and separately with the original run base.
Parent lineage must be accepted within the same run and protocol, and protected
paths must match the run base. Archived candidates from earlier runs are not
eligible parents. A per-commit image is required for each harness; image marker
and Docker image ID are checked before an attempt. Missing images or
non-comparable attempts fail closed.

The current local Ollama adapter does not provide supervisor-enforced
aggregate token accounting. Its guest-reported usage is observational, and
those attempts remain unqualified and cannot make a candidate eligible. The
proof gate can accept only attempts with authoritative resource accounting;
broker enforcement is required for a qualified live run. Confirmation
fixtures and verifier inputs are kept outside the coding guest and selection
inputs.

Trajectory datasets are written as separate `sft.jsonl`, `preferences.jsonl`,
and `failures.jsonl` files with a manifest. Their current verification derives
from RSI gates; it is not independent verification and must not be treated as
training-grade evidence.

RSI snapshots contain one sanitized commit rather than the source repository's
Git history. Mutation guests do not receive test files, RSI policy/scoring
code, hidden evaluator files, or candidate environment secrets. Visible
evaluation guests receive the test inputs needed by configured commands but
omit RSI internals, operator archives, and `scripts/eval-suite`. The supervisor
alone computes fitness and paired comparisons. The OpenShell image, configured
network policy, and gateway remain operator-managed; no multi-host deployment
or live gateway fleet has been qualified by the local integration tests.

## Curriculum fixture validation

Failure-derived curriculum proposals use the task wording and capability from
their checked-in fixture manifest. A proposal is eligible for validation only
when its fixture ID, task text, capability, description, and fixed argv command
match that manifest and it names at least one source candidate. The coordinator
submits two evaluation jobs against the run's clean base commit; workers execute
the registered fixture command in OpenShell guests. Missing fixtures, malformed
proposals, failed commands, or different output digests leave a task
unvalidated. A task marked `validated` passed the fixture's reference cases,
rejected its checked-in known mutant, and produced the same output digest in
both clean replays. This is execution and repeatability evidence; it does not
show that task wording measures the named capability.

Validation does not promote a task. After reviewing the archive, an operator
can promote one explicitly with
`npm run rsi:promote-curriculum -- --archive-dir <path> --task-id <id>`.
Promotion requires reproducible validation and records its timestamp in the
archive and associated run report.

## Adversarial review

When an adversary role is configured, the coordinator sends it a bounded
candidate diff and visible evaluation summary. The reviewer returns strict JSON
with findings and one to eight test cases. Each case can call only an exported
function in an eligible changed source file, with bounded JSON arguments and
expected output. The coordinator stores the prompt, provider response, test
specification, sanitized evaluation snapshot, and OpenShell output as
content-addressed artifacts. A fixed runner executes the generated checks in a
separate OpenShell evaluation guest; reviewer-provided shell commands are not
accepted. The coordinator alone applies the result: every generated test must
pass to keep the adversarial hard gate open, while each major finding costs five
fitness points and each minor finding one, capped at ten points.

The adversary model name must differ from the configured worker model name;
using the same model name through another provider does not qualify as
cross-model supervision. Supported adversary providers are Ollama and
OpenRouter. A configured command provider is rejected because no RSI command
adapter is implemented. This path is covered by mocked-provider and fake-fleet
tests, including failed replay and finding-penalty cases; no live
provider-backed adversarial run has been validated.

Set HEADLESSCODE_RSI_ROLE_ADVERSARY_MODEL and optionally
HEADLESSCODE_RSI_ROLE_ADVERSARY_PROVIDER (ollama by default for an added role,
or openrouter) and HEADLESSCODE_RSI_ROLE_ADVERSARY_BASE_URL. OpenRouter
credentials stay on the coordinator in HEADLESSCODE_OPENROUTER_API_KEY.
HEADLESSCODE_RSI_ROLE_WORKER_MODEL and HEADLESSCODE_RSI_ROLE_WORKER_PROVIDER
can explicitly set the worker identity used for the distinct-model check.

## Fixed-harness reliability benchmark

`headlesscode rsi-benchmark` runs the specified committed HeadlessCode harness
as the coding agent against separate, materialized task repositories. The
benchmark corpus has 32 historical repository changes split evenly between
development and confirmation, across tool security, agent completion, provider
runtime, and orchestration. Each task pins its starting tree, a known-good fix,
and a supervisor verifier. `check-oracles` runs the known-good and untouched
known-bad snapshots through the verifier in a separate OpenShell guest; it
stops if the guest cannot complete the verifier. A historical test assertion
failure rejects a known-bad snapshot; a verifier child timeout, signal, spawn
error, or reserved infrastructure exit invalidates the pair. The coding guest
receives one task repository and its task text, without the verifier files or
confirmation fixtures. The fixture materializer rejects symlinks and
submodules and checks tree paths and size limits before writing files.

Build both worker images from the clean, exact Git commit with the image
builder. It checks the worktree, safely materializes the selected commit, then
checks the marker and Docker image ID on both images. The resulting IDs are
stored in each attempt and in the frozen protocol:

```sh
HARNESS_COMMIT=$(git rev-parse HEAD)
npx tsx scripts/rsi-benchmark/build-image.mjs "$HARNESS_COMMIT"
export HEADLESSCODE_RSI_BENCHMARK_HARNESS_COMMIT="$HARNESS_COMMIT"
npx tsx src/cli.ts rsi-benchmark verify-fixtures
npx tsx src/cli.ts rsi-benchmark check-oracles
npx tsx src/cli.ts rsi-benchmark baseline --harness-commit "$HARNESS_COMMIT"
npx tsx src/cli.ts rsi-benchmark freeze --harness-commit "$HARNESS_COMMIT"
npx tsx src/cli.ts rsi-benchmark confirm --harness-commit "$HARNESS_COMMIT"
```

`check-oracles` writes per-task pass/fail status, verifier duration and output
digests, the manifest digest, and verifier image identity to
`.headlesscode/rsi-benchmark/oracle-qualification.json`.

`baseline` records task outcomes, including expected failures; exit status zero
means the requested task cells ran and were recorded, not that every task
passed. Setup, image-identity, and verifier failures invalidate the run. The
worker receives configured iteration, timeout, and per-call output-token
values, and the supervisor validates the imported patch size. Guest-reported
transcript counts are post-run observations; the worker can change that file,
so counts do not enforce call or token ceilings. Aggregate token enforcement is
unavailable, and attempts are not marked proof-qualified. Reports retain the
harness, model, manifest and verifier digests, per-task outcomes, guest-reported
resource observations, and replay artifact digests. Replaying an attempt
validates and re-verifies its referenced artifacts. Authoritative per-attempt
resource enforcement requires the broker planned for issue #17.

## Remaining work

- Issue #9 has a fixed OpenShell QLoRA prototype and CLI covered by mocked job
  tests. The supplied Q8 GGUF is rejected before enqueue; live training,
  adapter evaluation, larger-checkpoint paired evaluation, and model × harness
  factorial cells remain unvalidated.
- Add plateau detection, regression retention, and meta-evaluation of mutation
  strategies.
- Add a trusted hidden-evaluation service and validate cross-gateway recovery
  under real network, worker-loss, and artifact-store failures.
- Add signed evaluator provenance before using review outputs as
  training-grade evidence.
