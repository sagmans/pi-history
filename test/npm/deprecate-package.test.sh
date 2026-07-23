#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"

readonly DEPRECATION_TEXT='Moved; use @example/tool instead'

test_confirmation_passes_message_as_one_argument() {
	run_target deprecate-package.sh CONFIRM=deprecate-package OLD_PKG_SPEC='old-tool@*' DEPRECATION_MESSAGE="${DEPRECATION_TEXT}"
	assert_success || return 1
	read_fake_log
	assert_contains "${FAKE_LOG_CONTENT}" 'npm deprecate old-tool@\* Moved\;\ use\ @example/tool\ instead' || return 1
	assert_not_contains "${FAKE_LOG_CONTENT}" 'unpublish'
}

test_dry_run_prints_without_deprecation() {
	run_target deprecate-package.sh DRY_RUN=1 OLD_PKG_SPEC='old-tool@*' DEPRECATION_MESSAGE="${DEPRECATION_TEXT}"
	assert_success || return 1
	assert_contains "${OUTPUT}" 'npm deprecate old-tool@\*' || return 1
	read_fake_log
	assert_not_contains "${FAKE_LOG_CONTENT}" 'npm deprecate'
}

test_missing_inputs_are_rejected() {
	run_target deprecate-package.sh CONFIRM=deprecate-package OLD_PKG_SPEC= DEPRECATION_MESSAGE=
	assert_failure || return 1
	read_fake_log
	[ -z "${FAKE_LOG_CONTENT}" ]
}

test_unsafe_package_spec_is_rejected() {
	run_target deprecate-package.sh CONFIRM=deprecate-package OLD_PKG_SPEC='old-tool@*;npm unpublish' DEPRECATION_MESSAGE="${DEPRECATION_TEXT}"
	assert_failure || return 1
	read_fake_log
	[ -z "${FAKE_LOG_CONTENT}" ]
}

test_missing_confirmation_is_rejected() {
	run_target deprecate-package.sh OLD_PKG_SPEC='old-tool@*' DEPRECATION_MESSAGE="${DEPRECATION_TEXT}"
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'CONFIRM=deprecate-package'
}

run_test 'deprecation safely passes caller message and never unpublishes' test_confirmation_passes_message_as_one_argument
run_test 'deprecation dry-run prints without mutation' test_dry_run_prints_without_deprecation
run_test 'deprecation requires package range and message' test_missing_inputs_are_rejected
run_test 'deprecation rejects unsafe package specs' test_unsafe_package_spec_is_rejected
run_test 'deprecation requires action-specific confirmation' test_missing_confirmation_is_rejected
finish_tests
