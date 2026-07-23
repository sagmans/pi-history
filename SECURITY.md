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

## Exposed secrets

GitHub secret scanning covers the repository's full Git history and pull
requests. Push protection blocks supported secrets before they enter the
repository.

Report a discovered secret through the private vulnerability reporting link
above, not a public issue. Revoke or rotate the credential immediately; deleting
it from the latest revision does not remove it from Git history. Include the
secret type and affected commit and path, but redact the credential value.

Treat a push-protection alert as real unless verified otherwise. A maintainer may
bypass a false positive only with a recorded rationale. Any future allowlist
entry must match the narrowest practical pattern and document why the matched
value cannot authenticate; blanket file or directory exclusions are not
permitted.

## Supported versions

Only the latest release tag receives security fixes. There is no long-term
support line while the project is at 0.x.

## Scope notes

`pi-history` stores prompt history locally under the active
`<Pi agent directory>/pi-history/` (normally `~/.pi/agent/pi-history/`) with
private permissions (0700 directories, 0600 files) and never transmits data.

The profile-isolation upgrade freezes recognized legacy files under
`~/.pi/agent/pi-history-profile-migration-v1/`. That snapshot can contain
pre-upgrade history mixed across profiles; every profile import creates another
private copy. Existing profile targets are never merged or overwritten.
Migration rejects symlinked sources and resumes only its own private incomplete
claims after interruption. Remove only the bundle's `snapshot/` directory to
stop future imports; keep the bundle and `.complete` marker so later
default-profile prompts cannot be snapshotted.

Reports about local data exposure, cross-profile or cross-project history
leakage, unsafe file handling, or extension privilege abuse are in scope.
