#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"

test_confirmation_runs_exact_publish() {
	run_target bootstrap-publish.sh CONFIRM=bootstrap-publish
	assert_success || return 1
	read_fake_log
	assert_contains "${FAKE_LOG_CONTENT}" $'npm publish --access public' || return 1
	assert_not_contains "${FAKE_LOG_CONTENT}" 'unpublish'
}

test_dry_run_prints_without_publish() {
	run_target bootstrap-publish.sh DRY_RUN=1
	assert_success || return 1
	assert_contains "${OUTPUT}" 'npm publish --access public' || return 1
	read_fake_log
	assert_not_contains "${FAKE_LOG_CONTENT}" 'npm publish'
}

test_missing_confirmation_rejects_before_registry_call() {
	run_target bootstrap-publish.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'CONFIRM=bootstrap-publish' || return 1
	read_fake_log
	assert_not_contains "${FAKE_LOG_CONTENT}" 'npm view'
}

test_existing_package_is_rejected() {
	run_target bootstrap-publish.sh CONFIRM=bootstrap-publish FAKE_VIEW_MODE=exists
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'already exists' || return 1
	read_fake_log
	assert_not_contains "${FAKE_LOG_CONTENT}" 'npm publish'
}

test_unknown_registry_failure_is_not_treated_as_absent() {
	run_target bootstrap-publish.sh CONFIRM=bootstrap-publish FAKE_VIEW_MODE=unknown
	assert_status 7 || return 1
	assert_not_contains "${OUTPUT}" "${SECRET_MARKER}" || return 1
	read_fake_log
	assert_not_contains "${FAKE_LOG_CONTENT}" 'npm publish'
}

test_spoofed_not_found_does_not_authorize_publish() {
	run_target bootstrap-publish.sh CONFIRM=bootstrap-publish FAKE_VIEW_MODE=spoofed
	assert_status 7 || return 1
	read_fake_log
	assert_not_contains "${FAKE_LOG_CONTENT}" 'npm publish'
}

test_publish_failure_propagates() {
	run_target bootstrap-publish.sh CONFIRM=bootstrap-publish FAKE_FAIL_COMMAND=publish FAKE_FAIL_STATUS=23
	assert_status 23 || return 1
	assert_not_contains "${OUTPUT}" "${SECRET_MARKER}"
}

run_test 'confirmed bootstrap runs exact public publish' test_confirmation_runs_exact_publish
run_test 'bootstrap dry-run prints without publishing' test_dry_run_prints_without_publish
run_test 'bootstrap requires action-specific confirmation' test_missing_confirmation_rejects_before_registry_call
run_test 'bootstrap rejects an existing package' test_existing_package_is_rejected
run_test 'registry uncertainty cannot become package absence' test_unknown_registry_failure_is_not_treated_as_absent
run_test 'E404 text with wrong status cannot authorize publish' test_spoofed_not_found_does_not_authorize_publish
run_test 'publish failure propagates without secret output' test_publish_failure_propagates
finish_tests
