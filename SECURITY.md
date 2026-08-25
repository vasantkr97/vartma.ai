# Security policy

Vartma.ai handles provider credentials and private coding transcripts. Do not include a real API
key, prompt, repository content, database dump, or exploitable production URL in a public issue.

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/vasantkr97/vartma.ai/security/advisories/new). Include
the affected commit, deployment assumptions, reproduction steps, impact, and a suggested mitigation
when available. If secrets were exposed, revoke them before preparing the report.

The maintainers own initial triage. We target acknowledgement within three business days and an
initial severity/impact assessment within seven. Every accepted finding receives a named owner,
target resolution date, regression-test requirement, and disclosure decision in the private
advisory. Critical credential disclosure or cross-session data access should be contained
immediately; release timing depends on verified remediation rather than a fixed promise.

## Supported versions

The project is currently pre-release. Only the latest commit on `main` is supported. Production
operators should pin an immutable image digest or commit and follow the rollback and credential
rotation procedures in [operations and recovery](./docs/operations-and-recovery.md).

## Security release gate

A public production release requires passing dependency, secret-redaction, authentication,
path-confinement, malformed-stream, failure-recovery, clean-install, and container-hardening checks.
Independent review and signed release provenance remain mandatory external evidence; automated tests
do not replace them.
