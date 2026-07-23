#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"

readonly EXPECTED_HARDENING='npm access set mfa=publish @example/tool'

test_confirmation_runs_exact_hardening() {
	run_target harden-publishing.sh CONFIRM=harden-publishing
	assert_success || return 1
	read_fake_log
	assert_contains "${FAKE_LOG_CONTENT}" "${EXPECTED_HARDENING}"
}

test_dry_run_prints_without_mutation() {
	run_target harden-publishing.sh DRY_RUN=1
	assert_success || return 1
	assert_contains "${OUTPUT}" "${EXPECTED_HARDENING}" || return 1
	read_fake_log
	assert_not_contains "${FAKE_LOG_CONTENT}" 'npm access set'
}

test_missing_confirmation_is_rejected() {
	run_target harden-publishing.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'CONFIRM=harden-publishing'
}

test_cli_failure_propagates_without_leak() {
	run_target harden-publishing.sh CONFIRM=harden-publishing FAKE_FAIL_COMMAND=access FAKE_FAIL_STATUS=23
	assert_status 23 || return 1
	assert_not_contains "${OUTPUT}" "${SECRET_MARKER}"
}

run_test 'confirmed hardening disallows publish tokens' test_confirmation_runs_exact_hardening
run_test 'hardening dry-run prints without mutation' test_dry_run_prints_without_mutation
run_test 'hardening requires action-specific confirmation' test_missing_confirmation_is_rejected
run_test 'hardening CLI failure propagates without secret output' test_cli_failure_propagates_without_leak
finish_tests
