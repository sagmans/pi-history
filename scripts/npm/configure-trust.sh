#!/usr/bin/env bash
# Bind one package to one GitHub workflow with publish-only permission.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=scripts/npm/lib.sh
source "${SCRIPT_DIR}/lib.sh"

readonly ACTION='configure-trust'
readonly PKG_NAME="${PKG_NAME:-}"
readonly REPO="${REPO:-}"
readonly WORKFLOW_FILE="${WORKFLOW_FILE:-}"
readonly ENVIRONMENT="${ENVIRONMENT:-}"

validate_package_name "${PKG_NAME}"
validate_repository "${REPO}"
validate_workflow_file "${WORKFLOW_FILE}"
validate_environment "${ENVIRONMENT}"
require_workflow "${WORKFLOW_FILE}"
require_command "${NPM_BIN}"
require_command "${NODE_BIN}"
validate_package_metadata "${PKG_NAME}" "${REPO}"
require_confirmation "${ACTION}"
require_npm_version

printf 'target trust: %s (%s, %s, %s)\n' "${PKG_NAME}" "${REPO}" "${WORKFLOW_FILE}" "${ENVIRONMENT}"
run_mutation "${ACTION}" "${NPM_BIN}" trust github "${PKG_NAME}" \
	--file "${WORKFLOW_FILE}" \
	--repo "${REPO}" \
	--env "${ENVIRONMENT}" \
	--allow-publish \
	--yes
printf 'trusted publishing configured\n'
