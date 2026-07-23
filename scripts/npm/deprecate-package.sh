#!/usr/bin/env bash
# Deprecation preserves immutable package history; unpublish is intentionally absent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=scripts/npm/lib.sh
source "${SCRIPT_DIR}/lib.sh"

readonly ACTION='deprecate-package'
readonly OLD_PKG_SPEC="${OLD_PKG_SPEC:-}"
readonly DEPRECATION_MESSAGE="${DEPRECATION_MESSAGE:-}"

validate_package_spec "${OLD_PKG_SPEC}"
validate_message "${DEPRECATION_MESSAGE}"
require_command "${NPM_BIN}"
require_confirmation "${ACTION}"
require_npm_version

printf 'target package range: %s\n' "${OLD_PKG_SPEC}"
run_mutation "${ACTION}" "${NPM_BIN}" deprecate "${OLD_PKG_SPEC}" "${DEPRECATION_MESSAGE}"
printf 'package range deprecated\n'
