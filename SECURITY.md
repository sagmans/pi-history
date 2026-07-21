# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security reports.**

Report privately via GitHub's private vulnerability reporting:

<https://github.com/sagmans/pi-history/security/advisories/new>

If that route is unavailable, email the maintainer listed in
[`LICENSE`](LICENSE).

Please include:

- affected version or commit SHA,
- steps to reproduce,
- impact (what an attacker gains),
- whether prompt contents or other private data are involved.

**Redact real prompt contents.** History files may contain sensitive text;
never paste another person's prompts into a report.

You can expect an acknowledgement within 7 days. Fixes are released as patch
versions; reporters are credited in release notes unless they prefer
anonymity.

## Supported versions

Only the latest release tag receives security fixes. There is no long-term
support line while the project is at 0.x.

## Scope notes

`pi-history` stores prompt history locally under `~/.pi/agent/pi-history/`
with private permissions (0700 directories, 0600 files) and never transmits
data. Reports about local data exposure, cross-project history leakage,
unsafe file handling, or extension privilege abuse are in scope.
