#!/usr/bin/env bash
# Require interactive 2FA while preserving trusted OIDC publication.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=scripts/npm/lib.sh
source "${SCRIPT_DIR}/lib.sh"

readonly ACTION='harden-publishing'
readonly PKG_NAME="${PKG_NAME:-}"

validate_package_name "${PKG_NAME}"
require_command "${NPM_BIN}"
require_confirmation "${ACTION}"
require_npm_version

printf 'target package: %s\n' "${PKG_NAME}"
run_mutation "${ACTION}" "${NPM_BIN}" access set mfa=publish "${PKG_NAME}"
printf 'publishing hardened\n'
