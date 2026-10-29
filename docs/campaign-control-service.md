# Campaign-control API supervisor

`headlesscode campaign serve` runs the loopback campaign-control HTTP API and
its dashboard files. The API binds to `127.0.0.1:4391`; it does not run campaign
ticks or start RSI work. On MX, `scripts/campaign_control_supervisor.py`
checks the listener address, process command line, working directory, and API
status before adopting the existing process. If that process exits, it starts
only the installed fixed `headlesscode campaign serve` command, using bounded
retry delays.

The supervisor uses the existing home-directory registration and control
files. It does not set a model, budget, adapter, credential, or alternate
data-directory environment variable. Campaign data remains under
`~/.local/share/headlesscode/campaign-control/`. API authentication continues
to follow the existing campaign-control server configuration.

## Prerequisites

- Node.js and the supported `headlesscode` CLI wrapper are installed.
- The dashboard build exists at
  `~/Projects/capsize-web/apps/fleet-campaign-control/dist`, the path selected
  by `campaign serve`.
- The user cron daemon is running. The installer adds one marked `@reboot`
  entry and preserves unrelated entries.
- Port 4391 is free, or the existing campaign-control API is the process being
  adopted. Do not start a second instance beside the existing listener.

The installer checks the wrapper and dashboard build before changing cron. It
rejects a changed or duplicate managed entry and preserves cron output that it
cannot verify as the explicit no-crontab case. It does not inspect or copy
process environment values.

## Install and check

The reviewed supervisor was activated on the reference MX workstation on
2026-10-29. Use these commands to install on another authorized target or verify
the existing installation.

```sh
python3 scripts/manage_campaign_control_supervisor.py install
python3 scripts/manage_campaign_control_supervisor.py check
```

The supervisor checks every ten seconds. Restart delays increase from five
seconds to a five-minute cap. Production waits are interruptible, so rollback
can stop the supervisor promptly during backoff. It uses a private lock, PID
file, and log under
`~/.local/state/headlesscode/campaign-control-supervisor/`; it does not write
campaign state. If the port belongs to an unrecognized process, it leaves that
listener untouched and does not launch another process. For campaign data, use
`headlesscode campaign status --json`; do not use `campaign tick` as a service
health check.

## Rollback

```sh
python3 scripts/manage_campaign_control_supervisor.py rollback
```

Rollback validates the managed cron line before stopping the supervisor or
removing its installed artifact. It removes only its exact marked `@reboot`
line and stops the supervisor only when its PID matches the fixed launcher. It
does not signal the campaign API or delete registration, control state, job
history, or evidence. If the cron line or installed source was edited, rollback
stops and preserves it for review. Other cron entries are kept.

## Current activation status

The observed API process used the supported `campaign serve` command from the
HeadlessCode checkout. The user cron daemon was running; system and user systemd
managers were offline on the inspected MX host. This candidate uses the user
cron daemon. After source review and 16 focused synthetic tests, installation
and the live identity/status check passed. The existing API PID and all prior
cron entries were preserved; a private crontab snapshot and activation receipt
were retained. Reboot recovery has not been exercised on the live workstation.
No campaign tick entry, live campaign state, credentials, registration, or access
gate was changed.

## Synthetic checks

Run the focused unit suite through the shared build queue and compile-check the
Python modules:

```sh
python3 -m py_compile scripts/campaign_control_supervisor.py scripts/manage_campaign_control_supervisor.py scripts/test_campaign_control_supervisor.py
python3 -m unittest discover -s scripts -p 'test_campaign_control_supervisor.py' -v
```

The tests use temporary state and mocked listeners/processes. They cover exact
loopback process identity, unknown-listener refusal, singleton locking,
interruptible backoff, bounded restart delay, cron preservation, error handling,
rollback validation, and zombie process handling. They do not connect to the
campaign API or a provider.
