# Security profiles

`--security-profile` selects the execution trust boundary. `local` is the default: commands run with the invoking user's host authority and are not OS-contained. `contained` routes the task through OpenShell and fails before workload execution when its pinned profile, gateway, policy, evidence transport, or supervisor controls cannot be verified. It never falls back to local execution. `--execution-provider` remains a separate orchestration setting; selecting `--security-profile contained` requires OpenShell.

Contained execution currently supports a local Docker-backed OpenShell gateway whose enabled Docker driver configuration can bind-mount the configured Unix evidence socket and public key. The installed OpenShell 0.1.2 CLI exposes `sandbox create --driver-config-json`; the worker receives only an independent repository snapshot, an allowlisted environment, the scoped evidence runtime configuration, and explicitly granted provider credentials. The OpenShell policy must require Landlock, a non-root guest identity, an exact enforced remote inference endpoint for worker sessions, and no network endpoints for evaluation sessions. The worker image is pinned by digest. Operator profile and policy files, collector storage and signing keys, and host worktrees must remain outside guest mounts.

## Operator profile

The profile is versioned and reviewed out of band. Set `HEADLESSCODE_CONTAINED_PROFILE` to its path and `HEADLESSCODE_CONTAINED_PROFILE_SHA256` to the SHA-256 digest approved by the operator. The referenced policy digest, collector public-key fingerprint, gateway identity, image digest, and resource limits are part of that reviewed profile. Profile and policy files must be regular files outside the worker repository and must not be group- or world-writable. The evidence socket must already be reachable and outside the repository.

Example profile shape:

```yaml
version: 1
profile: contained
gateway: { identity: local-docker }
image: registry.example/headlesscode@sha256:<64-hex-image-digest>
policy: { path: contained-policy.yaml, sha256: <64-hex-policy-digest> }
resources: { cpu: "2", memory: 4Gi }
providers: [headlesscode-openrouter]
inference: { host: openrouter.ai, port: 443 }
evidence:
  transport: unix
  required: true
  socketPath: /home/worker/.local/share/headlesscode/evidence.sock
  guestPath: /run/headlesscode/evidence.sock
  publicKeyPath: collector-public.pem
  publicKeyGuestPath: /etc/headlesscode/collector.pem
  publicKeyFingerprint: sha256:<64-lowercase-hex-fingerprint>
externalControls: { emergencyStop: required, emergencyControllerIdentity: operator-controller-id, evaluatorSupervisorOnly: true }
```

The profile policy must explicitly set `filesystem_policy.include_workdir: false`, `landlock.compatibility: hard_requirement`, and non-root `process.run_as_user` and `process.run_as_group`. Its writable paths are limited to `/tmp`, `/dev/null`, `/workspace`, `/result`, `/opt/headlesscode-data/checkpoints`, and the configured evidence socket target. It must expose the pinned evidence key and supervisor-created runtime config read-only. Worker network policy contains only the configured inference endpoint with `enforcement: enforce`; evaluation policy contains no endpoints. Unknown writable paths, wildcards, symlinked or overlapping control paths, mutable profile digests, and mismatched runtime identity fail closed.

Before sandbox creation, HeadlessCode verifies the OpenShell CLI version and healthy gateway identity, then snapshots the exact reviewed policy bytes in private scratch storage. It passes a serialized resolved profile to the worker dispatcher; the dispatcher validates that immutable snapshot rather than reading the operator profile again. After creation it inspects the sandbox image and loaded effective policy before starting the task. The supervisor supplies the active emergency controller and per-session evidence capability as runtime objects. Contained launch checks the controller's actual identity and running state; profile declarations alone do not establish that external controls are active. Secrets are not copied into the task prompt or process environment.

## Limits

This profile is currently implemented for the local Docker driver and Unix socket evidence transport. A gateway that cannot mount the socket and collector key fails before the worker command runs. Remote gateway transport, alternate OpenShell drivers, and live GPU qualification are not covered here. Contained profile support does not disable local execution or local GPU features in the `local` profile. No live OpenShell or GPU qualification is implied by CPU-only automated tests.
