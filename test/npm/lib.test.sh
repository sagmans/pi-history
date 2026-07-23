#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"
readonly LIB_PATH="${REPO_ROOT}/scripts/npm/lib.sh"

if [ ! -f "${LIB_PATH}" ]; then
	printf 'missing %s\n' "${LIB_PATH}" >&2
	exit 1
fi
# shellcheck source=scripts/npm/lib.sh
source "${LIB_PATH}"

test_accepts_valid_inputs() {
	validate_package_name '@example/tool'
	validate_repository 'example/tool'
	validate_workflow_file 'release.yml'
	validate_environment 'npm-release'
	validate_reviewer 'release-owner'
	validate_tag_pattern 'release/v*'
	validate_version '1.2.3-rc.1'
}

test_rejects_invalid_inputs() {
	! (validate_package_name 'unscoped') >/dev/null 2>&1 || return 1
	! (validate_repository 'owner/repo/extra') >/dev/null 2>&1 || return 1
	! (validate_workflow_file '../release.yml') >/dev/null 2>&1 || return 1
	! (validate_environment 'release env') >/dev/null 2>&1 || return 1
	! (validate_reviewer 'owner;echo') >/dev/null 2>&1 || return 1
	! (validate_tag_pattern 'v*"') >/dev/null 2>&1 || return 1
	! (validate_version 'latest') >/dev/null 2>&1
}

test_compares_npm_versions() {
	version_at_least '11.15.0' '11.15.0' || return 1
	version_at_least '12.0.0' '11.15.0' || return 1
	version_at_least '11.16.0' '11.15.0' || return 1
	! version_at_least '11.14.9' '11.15.0' || return 1
	! version_at_least '11.15.0-beta.1' '11.15.0' || return 1
	! version_at_least '11.15.0unexpected' '11.15.0'
}

test_npm_version_failure_propagates() {
	export FAKE_LOG SECRET_MARKER
	set +e
	# Single quotes intentionally defer expansion to the isolated Bash process.
	# shellcheck disable=SC2016
	env FAKE_FAIL_COMMAND=--version FAKE_FAIL_STATUS=27 NPM_BIN="${FAKE_BIN}/npm" \
		bash -c 'source "$1"; require_npm_version' _ "${LIB_PATH}" >/dev/null 2>&1
	local status=$?
	set -e
	[ "${status}" -eq 27 ]
}

test_dry_run_escapes_without_execution() {
	DRY_RUN=1 CONFIRM='' run_mutation sample "${FAKE_BIN}/npm" publish 'value with spaces' 'semi;colon' >"${TEST_TMP}/output"
	local printed
	printed="$(<"${TEST_TMP}/output")"
	read_fake_log
	assert_contains "${printed}" 'value\ with\ spaces' || return 1
	assert_contains "${printed}" 'semi\;colon' || return 1
	[ -z "${FAKE_LOG_CONTENT}" ]
}

test_confirmation_is_action_specific() {
	! (DRY_RUN=0 CONFIRM=other run_mutation sample "${FAKE_BIN}/npm" publish) >/dev/null 2>&1 || return 1
	FAKE_LOG="${FAKE_LOG}" DRY_RUN=0 CONFIRM=sample \
		run_mutation sample "${FAKE_BIN}/npm" publish >/dev/null
	read_fake_log
	assert_contains "${FAKE_LOG_CONTENT}" 'npm publish'
}

run_test 'valid input formats are accepted' test_accepts_valid_inputs
run_test 'unsafe input formats are rejected' test_rejects_invalid_inputs
run_test 'npm versions compare numerically' test_compares_npm_versions
run_test 'npm version command failures propagate' test_npm_version_failure_propagates
run_test 'dry-run escapes commands without execution' test_dry_run_escapes_without_execution
run_test 'confirmation names the action' test_confirmation_is_action_specific
finish_tests
