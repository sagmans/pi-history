#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"

write_workflow() {
	printf '%s\n' "$1" >"${TEST_TMP}/project/.github/workflows/${DEFAULT_WORKFLOW}"
}

assert_workflow_rejected() {
	write_workflow "$1"
	run_target validate-workflow.sh
	assert_failure || return 1
	assert_contains "${OUTPUT}" "$2"
}

assert_workflow_accepted() {
	if (($# > 0)); then
		write_workflow "$1"
	fi
	run_target validate-workflow.sh
	assert_success || return 1
	assert_contains "${OUTPUT}" 'workflow passed'
}

test_valid_workflow_passes() {
	assert_workflow_accepted
}

test_tag_trigger_is_required() {
	assert_workflow_rejected $'name: release\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public' 'tag trigger'
}

test_environment_is_required() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public' 'environment'
}

test_oidc_permission_is_required() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    steps:\n      - run: npm publish --provenance --access public' 'id-token: write'
}

test_hardened_publish_command_is_required() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish' 'provenance and public access'
}

test_commented_publish_flags_are_rejected() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: |\n          npm publish # --provenance --access public' 'provenance and public access'
}

test_publish_text_without_execution_is_rejected() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: echo npm publish --provenance --access public' 'provenance and public access'
}

test_publish_step_with_extra_shell_command_is_rejected() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public; npm publish' 'provenance and public access'
}

test_multiple_publish_steps_are_rejected() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public\n      - run: npm publish' 'single hardened npm publish step'
}

test_misleading_run_text_cannot_supply_controls() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    steps:\n      - run: npm publish --provenance --access public\n      - run: |\n          environment: npm-release\n          id-token: write' 'environment'
}

test_commented_controls_are_rejected() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    # environment: npm-release\n    # id-token: write\n    steps:\n      - run: npm publish --provenance --access public' 'environment'
}

test_duplicate_jobs_are_rejected() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public\n  publish:\n    steps:\n      - run: echo hijacked' 'duplicate'
}

test_flow_duplicate_keys_are_rejected() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions: {id-token: read, id-token: write}\n    steps:\n      - run: npm publish --provenance --access public' 'duplicate'
}

test_split_controls_in_unrelated_job_are_rejected() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  approve:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: echo approved\n  publish:\n    steps:\n      - run: npm publish --provenance --access public' 'environment'
}

test_job_permissions_override_missing_id_token_is_rejected() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\npermissions:\n  id-token: write\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      contents: read\n    steps:\n      - run: npm publish --provenance --access public' 'id-token: write'
}

test_top_level_id_token_permission_is_inherited() {
	assert_workflow_accepted $'on:\n  push:\n    tags: ["v*"]\npermissions:\n  id-token: write\njobs:\n  publish:\n    environment: npm-release\n    steps:\n      - run: npm publish --provenance --access public'
}

test_multiple_publish_jobs_are_rejected() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public\n  publish-again:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public' 'single npm publish job'
}

test_block_anchors_and_aliases_are_rejected() {
	assert_workflow_rejected $'name: &release release\non:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public' 'anchors and aliases'
}

test_flow_anchors_and_aliases_are_rejected() {
	assert_workflow_rejected $'metadata: {anchor: &value safe, alias: *value}\non:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public' 'anchors and aliases'
}

test_malformed_yaml_is_rejected() {
	assert_workflow_rejected $'on: [\njobs: {}' 'valid YAML syntax'
}

test_trailing_yaml_is_rejected() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public\n- ignored' 'valid YAML syntax'
}

test_multiple_yaml_documents_are_rejected() {
	assert_workflow_rejected $'on:\n  push:\n    tags: ["v*"]\n---\njobs: {}' 'single YAML document'
}

test_explicit_tags_are_rejected() {
	assert_workflow_rejected $'name: !!str release\non:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public' 'explicit tags'
}

test_yaml_warnings_are_rejected() {
	assert_workflow_rejected $'%YAML 1.3\n---\non:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public' 'YAML warnings'
}

test_non_string_keys_are_rejected() {
	assert_workflow_rejected $'metadata:\n  1: value\non:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    environment: npm-release\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance --access public' 'string mapping keys'
}

run_test 'valid release workflow passes' test_valid_workflow_passes
run_test 'tag trigger is required' test_tag_trigger_is_required
run_test 'configured environment is required' test_environment_is_required
run_test 'OIDC token permission is required' test_oidc_permission_is_required
run_test 'publish requires provenance and public access' test_hardened_publish_command_is_required
run_test 'commented publish flags are rejected' test_commented_publish_flags_are_rejected
run_test 'publish text without execution is rejected' test_publish_text_without_execution_is_rejected
run_test 'publish step with extra shell command is rejected' test_publish_step_with_extra_shell_command_is_rejected
run_test 'multiple publish steps are rejected' test_multiple_publish_steps_are_rejected
run_test 'misleading run text cannot supply controls' test_misleading_run_text_cannot_supply_controls
run_test 'commented controls are rejected' test_commented_controls_are_rejected
run_test 'duplicate jobs are rejected' test_duplicate_jobs_are_rejected
run_test 'flow duplicate keys are rejected' test_flow_duplicate_keys_are_rejected
run_test 'split controls in an unrelated job are rejected' test_split_controls_in_unrelated_job_are_rejected
run_test 'job permissions overriding inherited id-token are rejected' test_job_permissions_override_missing_id_token_is_rejected
run_test 'top-level id-token permission is inherited' test_top_level_id_token_permission_is_inherited
run_test 'multiple publish jobs are rejected' test_multiple_publish_jobs_are_rejected
run_test 'block anchors and aliases are rejected' test_block_anchors_and_aliases_are_rejected
run_test 'flow anchors and aliases are rejected' test_flow_anchors_and_aliases_are_rejected
run_test 'malformed YAML is rejected' test_malformed_yaml_is_rejected
run_test 'trailing YAML is rejected' test_trailing_yaml_is_rejected
run_test 'multiple YAML documents are rejected' test_multiple_yaml_documents_are_rejected
run_test 'explicit tags are rejected' test_explicit_tags_are_rejected
run_test 'YAML warnings are rejected' test_yaml_warnings_are_rejected
run_test 'non-string mapping keys are rejected' test_non_string_keys_are_rejected
finish_tests
