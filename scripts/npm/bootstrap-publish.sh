#!/usr/bin/env bash
# Bootstrap only a package proven absent from the registry and a clean checkout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=scripts/npm/lib.sh
source "${SCRIPT_DIR}/lib.sh"

readonly ACTION='bootstrap-publish'
readonly PKG_NAME="${PKG_NAME:-}"
readonly REPO="${REPO:-}"

validate_package_name "${PKG_NAME}"
validate_repository "${REPO}"
require_command "${NPM_BIN}"
require_command "${GIT_BIN}"
require_command "${NODE_BIN}"
validate_package_metadata "${PKG_NAME}" "${REPO}"
require_clean_worktree
require_confirmation "${ACTION}"
require_npm_version

registry_error="$(mktemp)"
trap 'rm -f -- "${registry_error}"' EXIT
if "${NPM_BIN}" view "${PKG_NAME}" name --json >/dev/null 2>"${registry_error}"; then
	fail 'package already exists; bootstrap publish is not allowed'
else
	registry_status=$?
	if [ "${registry_status}" -ne 1 ] || ! grep -q 'E404' "${registry_error}"; then
		printf 'error: unable to prove package absence\n' >&2
		exit "${registry_status}"
	fi
fi

printf 'target package: %s\n' "${PKG_NAME}"
run_mutation "${ACTION}" "${NPM_BIN}" publish --access public
printf 'bootstrap publish completed\n'
