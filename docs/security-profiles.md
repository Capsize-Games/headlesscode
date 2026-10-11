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

Before sandbox creation, HeadlessCode verifies the OpenShell CLI version and healthy gateway identity, then snapshots the exact reviewed policy bytes in private scratch storage. It passes a serialized resolved profile to the worker dispatcher; the dispatcher validates that immutable snapshot rather than reading the operator profile again. After creation it inspects the sandbox image and loaded effective policy before starting the task. Each worker host process starts an emergency controller with the reviewed identity and a separate control-state directory, then supplies its per-session evidence capability as a read-only runtime file. Contained launch checks the controller's actual identity and running state; profile declarations alone do not establish that external controls are active. Collector signing keys and storage paths remain on the host. The scoped append capability is available to the guest only through the read-only runtime file.

## Provisioning supervisor services

Start the external collector before contained work. Use one unique session ID per worker and keep its storage, config directory, socket parent, control-state directory, and control-socket directory outside all repositories and OpenShell scratch data:

```sh
headlesscode evidence serve-contained \
  --storage-dir "$HOME/.local/share/headlesscode/evidence" \
  --socket "$HOME/.local/run/headlesscode-evidence.sock" \
  --config-dir "$HOME/.local/share/headlesscode/evidence-runtime" \
  --session round-20261010-w1 \
  --session round-20261010-w2
```

The command remains running as the collector supervisor. It creates owner-only signing-key storage and one read-only runtime config file per session. The config holds only that session's append capability, socket path, public key, and required-evidence setting. On orderly SIGINT or SIGTERM, the service revokes the sessions and removes those config files. Configure `HEADLESSCODE_CONTAINED_EVIDENCE_CONFIG_DIR` to the config directory, `HEADLESSCODE_CONTROL_STATE_DIR` to a separate private directory, and `HEADLESSCODE_CONTROL_SOCKET_DIR` to a separate socket directory. The socket-directory setting accepts `{session}` as a per-session path component when the operating system's Unix socket path limit requires a shorter directory.

Use the generated `ed25519-public.pem` as the profile's `evidence.publicKeyPath` and its `sha256:<fingerprint>` as `evidence.publicKeyFingerprint`. The profile's `evidence.socketPath` must be the same socket passed to `serve-contained`. Start a direct task with `--security-profile contained --session-id <provisioned-id>`; the ID must match its runtime config filename. For orchestrated rounds, set `HEADLESSCODE_CONTAINED_SESSION_PREFIX` to a unique round prefix and provision `<prefix>-<worktree-name>` for each worker. The orchestrator checks every named runtime config before spawning workers. Missing, reused, or mismatched configs stop launch before OpenShell starts.

Pause or stop a worker with `headlesscode control <emergencyControllerIdentity> pause --session <id> --reason "..."` or the corresponding `stop` action. After a pause, the original session's captured abort signal stays aborted. Start a fresh worker only after an operator explicitly runs `headlesscode control <emergencyControllerIdentity> resume --session <id>`; a new control session then receives a fresh signal. `headlesscode evidence verify <bundle.json> <pinned-key.json> <pinned-head.json>` runs offline evidence verification.

## Limits

This profile is currently implemented for the local Docker driver and Unix socket evidence transport. A gateway that cannot mount the socket and collector key fails before the worker command runs. Remote gateway transport, alternate OpenShell drivers, and live GPU qualification are not covered here. Contained profile support does not disable local execution or local GPU features in the `local` profile. No live OpenShell or GPU qualification is implied by CPU-only automated tests.
