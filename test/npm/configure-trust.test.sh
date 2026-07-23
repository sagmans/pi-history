#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"

readonly EXPECTED_TRUST='npm trust github @example/tool --file release.yml --repo example/tool --env npm-release --allow-publish --yes'

test_confirmation_runs_exact_trust_command() {
	run_target configure-trust.sh CONFIRM=configure-trust
	assert_success || return 1
	read_fake_log
	assert_contains "${FAKE_LOG_CONTENT}" "${EXPECTED_TRUST}"
}

test_dry_run_prints_without_trust_mutation() {
	run_target configure-trust.sh DRY_RUN=1
	assert_success || return 1
	assert_contains "${OUTPUT}" "${EXPECTED_TRUST}" || return 1
	read_fake_log
	assert_not_contains "${FAKE_LOG_CONTENT}" 'npm trust github'
}

test_missing_confirmation_is_rejected() {
	run_target configure-trust.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'CONFIRM=configure-trust'
}

test_minimum_npm_version_is_enforced() {
	run_target configure-trust.sh CONFIRM=configure-trust FAKE_NPM_VERSION=11.14.9
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'npm 11.15.0 or newer'
}

test_repository_mismatch_is_rejected_before_trust() {
	# Single quotes protect JavaScript template syntax from the shell.
	# shellcheck disable=SC2016
	"${REAL_NODE_BIN}" -e '
const fs = require("node:fs");
const path = process.argv[1];
const metadata = JSON.parse(fs.readFileSync(path, "utf8"));
metadata.repository.url = "https://github.com/example/other.git";
fs.writeFileSync(path, `${JSON.stringify(metadata)}\n`);
' "${TEST_TMP}/project/package.json"
	run_target configure-trust.sh CONFIRM=configure-trust
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'package.json repository does not match REPO' || return 1
	read_fake_log
	assert_not_contains "${FAKE_LOG_CONTENT}" 'npm trust github'
}

test_cli_failure_propagates_without_leak() {
	run_target configure-trust.sh CONFIRM=configure-trust FAKE_FAIL_COMMAND=trust FAKE_FAIL_STATUS=23
	assert_status 23 || return 1
	assert_not_contains "${OUTPUT}" "${SECRET_MARKER}"
}

run_test 'confirmed trust setup passes exact constrained identity' test_confirmation_runs_exact_trust_command
run_test 'trust dry-run prints without mutation' test_dry_run_prints_without_trust_mutation
run_test 'trust setup requires action-specific confirmation' test_missing_confirmation_is_rejected
run_test 'trust setup enforces npm minimum' test_minimum_npm_version_is_enforced
run_test 'trust setup rejects package repository mismatch' test_repository_mismatch_is_rejected_before_trust
run_test 'trust CLI failure propagates without secret output' test_cli_failure_propagates_without_leak
finish_tests
