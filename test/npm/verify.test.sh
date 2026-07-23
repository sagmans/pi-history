#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"

test_expected_public_package_and_trust_pass() {
	run_target verify.sh
	assert_success || return 1
	assert_contains "${OUTPUT}" 'verification passed' || return 1
	assert_not_contains "${OUTPUT}" "${SECRET_MARKER}"
}

test_private_access_is_rejected() {
	run_target verify.sh FAKE_ACCESS_JSON='{"status":"private"}'
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'package is not public'
}

test_wrong_trust_permission_is_rejected() {
	run_target verify.sh FAKE_TRUST_JSON='[{"type":"github","file":"release.yml","repository":"example/tool","environment":"npm-release","permissions":["createStagedPackage"]}]'
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'createPackage'
}

test_non_github_trust_is_rejected() {
	run_target verify.sh FAKE_TRUST_JSON='[{"type":"gitlab","file":"release.yml","repository":"example/tool","environment":"npm-release","permissions":["createPackage"]}]'
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'GitHub trusted publisher'
}

test_excess_trust_permission_is_rejected() {
	run_target verify.sh FAKE_TRUST_JSON='[{"type":"github","file":"release.yml","repository":"example/tool","environment":"npm-release","permissions":["createPackage","createStagedPackage"]}]'
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'publish-only createPackage'
}

test_missing_dist_integrity_is_rejected() {
	run_target verify.sh FAKE_METADATA_JSON='{"name":"@example/tool","version":"1.2.3","repository":{"url":"git+https://github.com/example/tool.git"},"dist":{"shasum":"0123456789abcdef"}}'
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'dist integrity'
}

test_cli_failure_status_propagates_without_leak() {
	run_target verify.sh FAKE_FAIL_COMMAND=trust FAKE_FAIL_STATUS=23
	assert_status 23 || return 1
	assert_not_contains "${OUTPUT}" "${SECRET_MARKER}"
}

run_test 'expected public package and publish trust verify' test_expected_public_package_and_trust_pass
run_test 'private package access fails verification' test_private_access_is_rejected
run_test 'staged-only trust fails publish verification' test_wrong_trust_permission_is_rejected
run_test 'non-GitHub trust fails verification' test_non_github_trust_is_rejected
run_test 'excess trust permissions fail verification' test_excess_trust_permission_is_rejected
run_test 'missing dist integrity fails verification' test_missing_dist_integrity_is_rejected
run_test 'verification CLI failure propagates without leaks' test_cli_failure_status_propagates_without_leak
finish_tests
