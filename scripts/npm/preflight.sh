#!/usr/bin/env bash
# Fail closed before the one-time npm and GitHub setup begins.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=scripts/npm/lib.sh
source "${SCRIPT_DIR}/lib.sh"

readonly PKG_NAME="${PKG_NAME:-}"
readonly REPO="${REPO:-}"
readonly WORKFLOW_FILE="${WORKFLOW_FILE:-}"
readonly ENVIRONMENT="${ENVIRONMENT:-}"
readonly REVIEWER="${REVIEWER:-}"
readonly TAG_PATTERN="${TAG_PATTERN:-}"

validate_package_name "${PKG_NAME}"
validate_repository "${REPO}"
validate_workflow_file "${WORKFLOW_FILE}"
validate_environment "${ENVIRONMENT}"
validate_reviewer "${REVIEWER}"
validate_tag_pattern "${TAG_PATTERN}"
require_command "${NPM_BIN}"
require_command "${GH_BIN}"
require_command "${GIT_BIN}"
require_command "${NODE_BIN}"
require_npm_version
validate_package_metadata "${PKG_NAME}" "${REPO}"
require_clean_worktree
bash "${SCRIPT_DIR}/validate-workflow.sh" >/dev/null

"${NPM_BIN}" whoami >/dev/null 2>&1 || fail 'npm authentication check failed'
"${GH_BIN}" auth status >/dev/null 2>&1 || fail 'GitHub authentication check failed'

printf 'preflight passed: %s (%s)\n' "${PKG_NAME}" "${REPO}"
