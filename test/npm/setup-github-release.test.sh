#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"

test_confirmation_creates_environment_policy_and_ruleset() {
	run_target setup-github-release.sh CONFIRM=setup-github-release
	assert_success || return 1
	read_fake_log
	read_payload_log
	assert_contains "${FAKE_LOG_CONTENT}" 'gh api repos/example/tool/environments/npm-release -X PUT --input -' || return 1
	assert_contains "${FAKE_LOG_CONTENT}" 'deployment-branch-policies -X POST' || return 1
	assert_contains "${FAKE_LOG_CONTENT}" 'gh api repos/example/tool/rulesets -X POST --input -' || return 1
	assert_contains "${FAKE_PAYLOAD_CONTENT}" '"can_admins_bypass": false' || return 1
	assert_contains "${FAKE_PAYLOAD_CONTENT}" '"id": 123' || return 1
	assert_contains "${FAKE_PAYLOAD_CONTENT}" 'refs/tags/v*'
}

test_setup_creates_missing_environment_before_policy_read() {
	run_target setup-github-release.sh CONFIRM=setup-github-release FAKE_ENVIRONMENT_ABSENT=1
	assert_success || return 1
	read_fake_log
	assert_contains "${FAKE_LOG_CONTENT}" 'environments/npm-release -X PUT' || return 1
	assert_contains "${FAKE_LOG_CONTENT}" 'deployment-branch-policies --jq'
}

test_dry_run_prints_without_remote_mutations() {
	run_target setup-github-release.sh DRY_RUN=1
	assert_success || return 1
	assert_contains "${OUTPUT}" 'repos/example/tool/environments/npm-release' || return 1
	read_fake_log
	assert_not_contains "${FAKE_LOG_CONTENT}" ' -X '
}

test_missing_confirmation_rejects_before_cli_calls() {
	run_target setup-github-release.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'CONFIRM=setup-github-release' || return 1
	read_fake_log
	[ -z "${FAKE_LOG_CONTENT}" ]
}

test_existing_resources_are_updated_idempotently() {
	run_target setup-github-release.sh CONFIRM=setup-github-release FAKE_POLICY_NAMES=$'v*\n' FAKE_RULESET_ID=456
	assert_success || return 1
	read_fake_log
	assert_not_contains "${FAKE_LOG_CONTENT}" 'deployment-branch-policies -X POST' || return 1
	assert_contains "${FAKE_LOG_CONTENT}" 'gh api repos/example/tool/rulesets/456 -X PUT --input -'
}

test_invalid_identity_inputs_fail_before_cli_calls() {
	run_target setup-github-release.sh CONFIRM=setup-github-release REVIEWER='owner;echo'
	assert_failure || return 1
	read_fake_log
	[ -z "${FAKE_LOG_CONTENT}" ] || return 1
	: >"${FAKE_LOG}"
	run_target setup-github-release.sh CONFIRM=setup-github-release TAG_PATTERN='v*"'
	assert_failure || return 1
	read_fake_log
	[ -z "${FAKE_LOG_CONTENT}" ] || return 1
	: >"${FAKE_LOG}"
	run_target setup-github-release.sh CONFIRM=setup-github-release TAG_PATTERN='../v*'
	assert_failure || return 1
	read_fake_log
	[ -z "${FAKE_LOG_CONTENT}" ]
}

test_legacy_entrypoint_delegates_to_guarded_setup() {
	run_script_path "${REPO_ROOT}/scripts/release/setup-github-oidc-release.sh" DRY_RUN=1
	assert_success || return 1
	assert_contains "${OUTPUT}" 'repos/example/tool/environments/npm-release' || return 1
	read_fake_log
	assert_not_contains "${FAKE_LOG_CONTENT}" ' -X '
}

test_api_failure_propagates_without_leak_or_retry() {
	run_target setup-github-release.sh CONFIRM=setup-github-release FAKE_FAIL_ENDPOINT='users/release-owner' FAKE_FAIL_STATUS=29
	assert_status 29 || return 1
	assert_not_contains "${OUTPUT}" "${SECRET_MARKER}" || return 1
	read_fake_log
	local calls
	calls="$(grep -c 'gh api users/release-owner' "${FAKE_LOG}" || true)"
	[ "${calls}" -eq 1 ]
}

run_test 'GitHub setup creates environment policy and ruleset' test_confirmation_creates_environment_policy_and_ruleset
run_test 'GitHub setup creates environment before reading its policies' test_setup_creates_missing_environment_before_policy_read
run_test 'GitHub dry-run performs no remote mutations' test_dry_run_prints_without_remote_mutations
run_test 'GitHub setup requires action-specific confirmation' test_missing_confirmation_rejects_before_cli_calls
run_test 'GitHub setup updates existing resources idempotently' test_existing_resources_are_updated_idempotently
run_test 'GitHub setup rejects unsafe identity inputs' test_invalid_identity_inputs_fail_before_cli_calls
run_test 'legacy GitHub entrypoint delegates to guarded setup' test_legacy_entrypoint_delegates_to_guarded_setup
run_test 'GitHub API failure propagates once without leaks' test_api_failure_propagates_without_leak_or_retry
finish_tests
