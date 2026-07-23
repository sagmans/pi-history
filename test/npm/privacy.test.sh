#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"

test_scripts_contain_no_project_or_local_identity() {
	local scripts_dir="${REPO_ROOT}/scripts/npm"
	[ -d "${scripts_dir}" ] || return 1
	if grep -R -E 'sagmans|pi-history|/Users/|https://[^[:space:]]*(auth|login)[^[:space:]]*' "${scripts_dir}" >/dev/null 2>&1; then
		return 1
	fi
}

test_token_shaped_environment_is_never_printed() {
	run_target preflight.sh NPM_TOKEN="${SECRET_MARKER}" NODE_AUTH_TOKEN="${SECRET_MARKER}"
	assert_success || return 1
	assert_not_contains "${OUTPUT}" "${SECRET_MARKER}"
}

run_test 'npm scripts contain no project or local identity' test_scripts_contain_no_project_or_local_identity
run_test 'token-shaped environment values are not printed' test_token_shaped_environment_is_never_printed
finish_tests
