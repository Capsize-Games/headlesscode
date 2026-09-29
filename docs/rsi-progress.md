# RSI Progress

Last reviewed: 2026-09-29

The coordinator now uses a PostgreSQL-backed queue and a shared S3-compatible
artifact store for candidate mutation and visible evaluation jobs. Each
`headlesscode rsi-worker` process is configured for one OpenShell gateway and
one active guest. Workers can be registered on different gateways against the
same database and object store; gateway discovery and live multi-host
qualification are not implemented.

## Evidence and limits

- Queue integration tests against disposable local PostgreSQL and RustFS
  exercised 12 simulated workers and 100 queued jobs, global/class/key admission
  caps, lease expiry and fencing, retry exhaustion, stale worker heartbeats,
  process restart idempotency, and a 20 MiB artifact transfer.
- OpenShell isolation tests use a fake provider and check sanitized mutation
  and evaluation bundles. A prior bounded local OpenShell candidate run passed
  visible checks but made no change and was rejected.
- On 2026-09-29, a bounded controller run completed with two candidates and
  generation one (report `rsi-20260929005216-010960a3.md`). The baseline
  visible evaluation ran remotely, both mutation jobs completed, and the
  controller admitted both candidate evaluation jobs before waiting. Two
  worker identities on the same configured `rsi-local` gateway held those
  evaluation leases concurrently from 01:05:00.600Z through 01:05:04.608Z
  (4.008 seconds between queue polls; observed active count 2). This validates
  same-gateway queue fan-out and separate OpenShell guests, not multi-gateway
  or multi-host operation. At the time of the run, `openshell gateway list`
  showed `rsi-local` as the reachable gateway and `headlesscode-local` at
  `http://127.0.0.1:18080`; a TCP connection to the latter was refused, so no
  second live gateway was available for cross-gateway qualification. Both
  candidates passed 2/2 visible/regression
  trials while baseline passed 1/2 on a temporary `clamp.js` fixture; both
  produced the same 764-byte patch (`6604d57d1ef78586e3d28d61eb11da8ef145de5f3115e31fcf52d4c952823c0d`).
  This is fixture-level evidence, not a general headlesscode improvement.
  Hidden evaluation count was zero; the current empty-suite rate helper reports
  `hidden: 1`, so the score includes an untested hidden component. That value
  is not hidden-test evidence. One mutation job retried once; its stored
  first-attempt error is truncated after iteration 6, so the terminal failure
  cause is unavailable.
- No live multi-gateway fleet run has been validated. The local queue tests
  simulate worker identities; they do not establish cross-host network or
  gateway behavior.
- Hidden evaluation is disabled. Evaluation suites must remain unavailable to
  candidate guests, and no trusted hidden-evaluation service exists yet.
- Fitness and paired baseline comparison run in the coordinator after visible
  results return. The bounded fixture run is not evidence of general harness
  improvement or independent validation.
- The opt-in `adaptive-independent` policy evaluates the configured initial
  population, then may admit one follow-up candidate on mixed outcome evidence.
  It requires one adaptive generation, caps trajectories at population plus
  one, records evidence and stop reasons in the archive/report, and respects
  iteration, runtime-admission, and queue-concurrency bounds. Runtime does not
  terminate already running jobs; no repeated follow-up stages are supported.
- Curriculum proposals are validated only after the exact registered fixture
  passes its reference cases, rejects a known mutant, and yields identical
  output digests on two clean-base OpenShell replays. This records fixture
  execution and repeatability, not that wording measures the named capability.
  Validation does not promote a task; operators promote explicitly with
  `npm run rsi:promote-curriculum -- --archive-dir <path> --task-id <id>`.
  Trajectory labels are not independently verified and are not training-grade
  evidence.
- Adversarial review now routes through a configured Ollama or OpenRouter role,
  records prompt/result/test provenance, and runs bounded generated checks in
  OpenShell evaluation guests. Failed or incomplete checks close the candidate
  hard gate; findings apply a capped score penalty. This path has controller
  tests but no live provider-backed review run. Automatic gateway discovery is
  not implemented.
- Issue #9 now has a fixed OpenShell QLoRA fixture-smoke command. It builds a
  three-row dataset from evaluator fixtures whose reference passes and known
  mutant fails, trains for eight steps at seed 1337, then evaluates base and
  adapter on the same three held-out cells. The metric is exact normalized
  solution-text match rate. Training requests one OpenShell GPU; paired
  evaluation is CPU-only and rejects checkpoints over 2 GiB. No live training
  run has been performed because there is no local Hugging Face checkpoint.
  The training image has been built; the local Ollama model is not a Hugging
  Face checkpoint. This fixture smoke path does not establish generalized
  model improvement or scale qualification.
- PostgreSQL claims currently lock one queue-policy row while enforcing
  queue-wide admission limits. A disposable same-host PostgreSQL/RustFS load
  test first claimed and completed four jobs to verify admission, then drained
  the remaining 96 jobs with 12 simulated workers in 446 ms (215.2 jobs/s), with
  two overlapping jobs under a cap of four. This is a local functional
  measurement, not a multi-host throughput envelope. Larger-model evaluation
  needs a GPU-capable evaluation resource class before it can exceed the 2 GiB
  CPU bound.

Earlier local Qwen runs from 2026-09-20 remain historical records:
`rsi-20260920091313-78f3e206` reached its eight-iteration cap, and
`rsi-20260920025005-b0ef3ddf` had two workers reach the 20-iteration cap.
Neither selected a candidate. These runs predate the current OpenShell and
PostgreSQL fleet path.
