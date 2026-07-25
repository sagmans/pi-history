#!/usr/bin/env bash
# Validate the release workflow before any registry or repository mutation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=scripts/npm/lib.sh
source "${SCRIPT_DIR}/lib.sh"

readonly WORKFLOW_FILE="${WORKFLOW_FILE:-}"
readonly ENVIRONMENT="${ENVIRONMENT:-}"

validate_workflow_file "${WORKFLOW_FILE}"
validate_environment "${ENVIRONMENT}"
require_command "${NODE_BIN}"
require_workflow "${WORKFLOW_FILE}"

"${NODE_BIN}" "${SCRIPT_DIR}/lib/workflow-validate.mjs" \
	".github/workflows/${WORKFLOW_FILE}" "${ENVIRONMENT}"

printf 'workflow passed: %s\n' "${WORKFLOW_FILE}"
