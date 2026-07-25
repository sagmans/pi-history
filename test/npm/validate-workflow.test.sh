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

test_misleading_run_text_cannot_supply_controls() {
	write_workflow $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    steps:\n      - run: npm publish --provenance --access public\n      - run: |\n          environment: npm-release\n          id-token: write'
	run_target validate-workflow.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'environment'
}

test_commented_controls_are_rejected() {
	write_workflow $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    # environment: npm-release\n    # id-token: write\n    steps:\n      - run: npm publish --provenance --access public'
	run_target validate-workflow.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'environment'
}

test_duplicate_jobs_are_rejected() {
	write_workflow $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public\n  publish:\n    steps:\n      - run: echo hijacked'
	run_target validate-workflow.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'duplicate'
}

test_split_controls_in_unrelated_job_are_rejected() {
	write_workflow $'on:\n  push:\n    tags: ["v*"]\njobs:\n  approve:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: echo approved\n  publish:\n    steps:\n      - run: npm publish --provenance --access public'
	run_target validate-workflow.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'environment'
}

test_job_permissions_override_missing_id_token_is_rejected() {
	write_workflow $'on:\n  push:\n    tags: ["v*"]\npermissions:\n  id-token: write\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      contents: read\n    steps:\n      - run: npm publish --provenance --access public'
	run_target validate-workflow.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'id-token: write'
}

test_top_level_id_token_permission_is_inherited() {
	write_workflow $'on:\n  push:\n    tags: ["v*"]\npermissions:\n  id-token: write\njobs:\n  publish:\n    environment: npm-release\n    steps:\n      - run: npm publish --provenance --access public'
	run_target validate-workflow.sh
	assert_success || return 1
	assert_contains "${OUTPUT}" 'workflow passed'
}

test_multiple_publish_jobs_are_rejected() {
	write_workflow $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public\n  publish-again:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public'
	run_target validate-workflow.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" 'single npm publish job'
}

run_test 'valid release workflow passes' test_valid_workflow_passes
run_test 'tag trigger is required' test_tag_trigger_is_required
run_test 'configured environment is required' test_environment_is_required
run_test 'OIDC token permission is required' test_oidc_permission_is_required
run_test 'publish requires provenance and public access' test_hardened_publish_command_is_required
run_test 'misleading run text cannot supply controls' test_misleading_run_text_cannot_supply_controls
run_test 'commented controls are rejected' test_commented_controls_are_rejected
run_test 'duplicate jobs are rejected' test_duplicate_jobs_are_rejected
run_test 'split controls in an unrelated job are rejected' test_split_controls_in_unrelated_job_are_rejected
run_test 'job permissions overriding inherited id-token are rejected' test_job_permissions_override_missing_id_token_is_rejected
run_test 'top-level id-token permission is inherited' test_top_level_id_token_permission_is_inherited
run_test 'multiple publish jobs are rejected' test_multiple_publish_jobs_are_rejected
finish_tests
