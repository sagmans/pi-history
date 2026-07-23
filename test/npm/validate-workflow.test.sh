#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"

write_workflow() {
	printf '%s\n' "$1" >"${TEST_TMP}/project/.github/workflows/${DEFAULT_WORKFLOW}"
}

test_valid_workflow_passes() {
	run_target validate-workflow.sh
	assert_success || return 1
	assert_contains "${OUTPUT}" 'workflow passed'
}

test_tag_trigger_is_required() {
	write_workflow $'name: release\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public'
	run_target validate-workflow.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'tag trigger'
}

test_environment_is_required() {
	write_workflow $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public'
	run_target validate-workflow.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'environment'
}

test_oidc_permission_is_required() {
	write_workflow $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    steps:\n      - run: npm publish --provenance --access public'
	run_target validate-workflow.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'id-token: write'
}

test_hardened_publish_command_is_required() {
	write_workflow $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish'
	run_target validate-workflow.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'provenance and public access'
}

run_test 'valid release workflow passes' test_valid_workflow_passes
run_test 'tag trigger is required' test_tag_trigger_is_required
run_test 'configured environment is required' test_environment_is_required
run_test 'OIDC token permission is required' test_oidc_permission_is_required
run_test 'publish requires provenance and public access' test_hardened_publish_command_is_required
finish_tests
