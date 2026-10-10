# Security incident response

## Reporting and intake

Use GitHub's private vulnerability reporting form for this repository:
<https://github.com/Capsize-Games/headlesscode/security/advisories/new>.
The repository is public and private vulnerability reporting is enabled. If
that form is unavailable, open an issue tagged `security` and include only a
brief description asking for a private follow-up route. Do not put exploit
details, credentials, user data, or other sensitive evidence in a public issue.

Record the report date, affected component and versions or commit, conditions
needed to reproduce the behavior, observed impact, and any known workaround.
Ask the reporter what contact method and disclosure timing they prefer. Do not
promise a response time or a particular outcome.

## Triage and containment

Reproduce the report in an isolated workspace with test data. Determine which
versions, configurations, and execution paths are affected, and whether the
behavior could expose data, run unintended commands, or change persistent
state. Keep the report's evidence and reproduction material access-limited;
remove credentials and personal data from copies used for testing.

When an active risk is confirmed, limit exposure while a fix is prepared. This
can include disabling the affected feature or workflow, pausing affected jobs,
restricting access to affected artifacts, and publishing a temporary
workaround. Preserve the relevant logs, configuration, and artifacts in a
restricted location before cleanup or rebuild. Do not copy secrets into an
issue, pull request, test fixture, or public advisory.

## Fix, notification, and disclosure

Prepare and review a fix, then verify it against the reported behavior and
nearby regression cases. Identify affected versions and the fixed version from
the repository tags and package metadata. Notify affected users through the
project's release and security advisory channels with the affected versions,
impact, available mitigation, and upgrade path. Coordinate advisory timing and
technical detail with the reporter; publish enough information for users to
assess and address the risk without exposing user secrets or unrelated private
evidence.

## Post-incident review

Record the timeline, affected versions and configurations, impact, containment,
fix, user notification, and disclosure decision. Review which controls failed
or were missing, and whether runtime behavior or configuration should change.
Assign concrete follow-up work and verify those changes before closing it.

## Report template

```text
Summary:
Affected component and versions/commit:
Required configuration or conditions:
Reproduction steps (use test data):
Observed behavior and potential impact:
Workaround, if known:
Evidence available (do not attach credentials or user data):
Preferred contact method:
Disclosure timing or coordination preference:
```
