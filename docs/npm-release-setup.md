# CLI-only npm release setup

These maintainer scripts bootstrap a public scoped package, constrain GitHub OIDC publication, and harden npm against token publishing. They contain no project identity or credentials and must run from the target repository root.

## Prerequisites

- npm `11.15.0` or newer; scripts validate but never install global tooling.
- Authenticated npm CLI account with package write access and account-level 2FA.
- Authenticated `gh` CLI account with repository administration access.
- Clean Git checkout containing `package.json` and `.github/workflows/<workflow>`.
- Release workflow triggered by tags, using the configured environment, `id-token: write`, and `npm publish --provenance --access public`.

Set explicit target values. These examples are synthetic:

```bash
export PKG_NAME='@example/tool'
export PKG_VERSION='1.2.3'
export REPO='example/tool'
export WORKFLOW_FILE='release.yml'
export ENVIRONMENT='npm-release'
export REVIEWER='release-owner'
export TAG_PATTERN='v*'
```

## Setup order

Validate local metadata, workflow, CLI versions, authentication, and checkout state:

```bash
bash scripts/npm/preflight.sh
bash scripts/npm/validate-workflow.sh
```

Preview, then provision the approval-gated GitHub environment, tag deployment policy, and admin-only tag ruleset:

```bash
DRY_RUN=1 bash scripts/npm/setup-github-release.sh
CONFIRM=setup-github-release bash scripts/npm/setup-github-release.sh
```

Bootstrap only when the package does not exist. The script fails closed unless npm returns an explicit not-found response:

```bash
DRY_RUN=1 bash scripts/npm/bootstrap-publish.sh
CONFIRM=bootstrap-publish bash scripts/npm/bootstrap-publish.sh
```

Create publish-only GitHub trust, then require interactive 2FA and disallow traditional publish tokens:

```bash
DRY_RUN=1 bash scripts/npm/configure-trust.sh
CONFIRM=configure-trust bash scripts/npm/configure-trust.sh

DRY_RUN=1 bash scripts/npm/harden-publishing.sh
CONFIRM=harden-publishing bash scripts/npm/harden-publishing.sh
```

Verify the public package version, registry integrity metadata, repository identity, and exact publish trust:

```bash
bash scripts/npm/verify.sh
```

## Optional package migration

Deprecate an old package range only after the replacement verifies. Unpublishing is intentionally unsupported:

```bash
export OLD_PKG_SPEC='old-tool@*'
export DEPRECATION_MESSAGE='Moved; use @example/tool instead'
DRY_RUN=1 bash scripts/npm/deprecate-package.sh
CONFIRM=deprecate-package bash scripts/npm/deprecate-package.sh
```

Each mutation needs its own exact `CONFIRM` value. `DRY_RUN=1` prints shell-escaped commands and performs no mutation. Scripts neither retry nor poll, and they suppress child CLI response bodies so credentials and authentication URLs are not copied into logs.

Signed tags, pushes, approval decisions, and GitHub release creation remain governed by each repository's release policy; this setup suite does not bypass those gates.
