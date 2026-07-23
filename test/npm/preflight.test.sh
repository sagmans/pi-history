#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"

test_valid_setup_passes_without_leaks() {
	run_target preflight.sh
	assert_success || return 1
	assert_contains "${OUTPUT}" 'preflight passed' || return 1
	assert_not_contains "${OUTPUT}" "${SECRET_MARKER}"
}

test_missing_package_fails_before_cli_calls() {
	run_target preflight.sh PKG_NAME=
	assert_failure || return 1
	read_fake_log
	[ -z "${FAKE_LOG_CONTENT}" ]
}

test_unscoped_package_is_rejected() {
	run_target preflight.sh PKG_NAME=tool
	assert_failure || return 1
	read_fake_log
	[ -z "${FAKE_LOG_CONTENT}" ]
}

test_invalid_repository_is_rejected() {
	run_target preflight.sh REPO='example/tool;echo'
	assert_failure || return 1
	read_fake_log
	[ -z "${FAKE_LOG_CONTENT}" ]
}

test_invalid_workflow_is_rejected() {
	run_target preflight.sh WORKFLOW_FILE='../release.yml'
	assert_failure || return 1
	read_fake_log
	[ -z "${FAKE_LOG_CONTENT}" ]
}

test_invalid_environment_is_rejected() {
	run_target preflight.sh ENVIRONMENT='npm release'
	assert_failure || return 1
	read_fake_log
	[ -z "${FAKE_LOG_CONTENT}" ]
}

test_old_npm_is_rejected() {
	run_target preflight.sh FAKE_NPM_VERSION=11.14.9
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'npm 11.15.0 or newer'
}

test_missing_executable_is_actionable() {
	run_target preflight.sh NPM_BIN=missing-npm
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'required command not found: missing-npm'
}

test_invalid_package_json_fails_without_local_path() {
	printf '%s\n' '{invalid' >"${TEST_TMP}/project/package.json"
	run_target preflight.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'package.json must contain valid JSON' || return 1
	assert_not_contains "${OUTPUT}" "${TEST_TMP}"
}

test_dirty_checkout_is_rejected() {
	run_target preflight.sh FAKE_GIT_STATUS='?? local-file'
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'working tree must be clean'
}

run_test 'valid setup passes without authentication leaks' test_valid_setup_passes_without_leaks
run_test 'missing package fails before CLI calls' test_missing_package_fails_before_cli_calls
run_test 'unscoped package is rejected' test_unscoped_package_is_rejected
run_test 'invalid repository is rejected before CLI calls' test_invalid_repository_is_rejected
run_test 'invalid workflow is rejected before CLI calls' test_invalid_workflow_is_rejected
run_test 'invalid environment is rejected before CLI calls' test_invalid_environment_is_rejected
run_test 'npm below minimum is rejected' test_old_npm_is_rejected
run_test 'missing executable has actionable error' test_missing_executable_is_actionable
run_test 'invalid package JSON fails without leaking local paths' test_invalid_package_json_fails_without_local_path
run_test 'dirty checkout is rejected' test_dirty_checkout_is_rejected
finish_tests
