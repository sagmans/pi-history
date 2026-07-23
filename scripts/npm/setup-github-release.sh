#!/usr/bin/env bash
# Provision approval-gated GitHub release controls without stored credentials.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=scripts/npm/lib.sh
source "${SCRIPT_DIR}/lib.sh"

readonly ACTION='setup-github-release'
readonly REPO="${REPO:-}"
readonly REVIEWER="${REVIEWER:-}"
readonly ENVIRONMENT="${ENVIRONMENT:-}"
readonly TAG_PATTERN="${TAG_PATTERN:-}"
readonly RULESET_NAME='release-tags-admin-only'
readonly ADMIN_ROLE_ID=5

validate_repository "${REPO}"
validate_reviewer "${REVIEWER}"
validate_environment "${ENVIRONMENT}"
validate_tag_pattern "${TAG_PATTERN}"
require_command "${GH_BIN}"
require_confirmation "${ACTION}"
"${GH_BIN}" auth status >/dev/null 2>&1 || fail 'GitHub authentication check failed'

if reviewer_id="$("${GH_BIN}" api "users/${REVIEWER}" --jq '.id' 2>/dev/null)"; then
	[[ "${reviewer_id}" =~ ^[0-9]+$ ]] || fail 'GitHub returned an invalid reviewer ID'
else
	status=$?
	printf 'error: unable to resolve reviewer\n' >&2
	exit "${status}"
fi

readonly environment_endpoint="repos/${REPO}/environments/${ENVIRONMENT}"
readonly policy_endpoint="${environment_endpoint}/deployment-branch-policies"
readonly ruleset_endpoint="repos/${REPO}/rulesets"
environment_payload="$(cat <<JSON
{
  "can_admins_bypass": false,
  "reviewers": [{"type": "User", "id": ${reviewer_id}}],
  "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}
}
JSON
)"
readonly environment_payload
ruleset_payload="$(cat <<JSON
{
  "name": "${RULESET_NAME}",
  "target": "tag",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/tags/${TAG_PATTERN}"], "exclude": []}},
  "rules": [{"type": "creation"}, {"type": "update"}, {"type": "deletion"}],
  "bypass_actors": [{"actor_id": ${ADMIN_ROLE_ID}, "actor_type": "RepositoryRole", "bypass_mode": "always"}]
}
JSON
)"
readonly ruleset_payload

printf 'target repository: %s\n' "${REPO}"
run_mutation_with_input "${ACTION}" "${environment_payload}" \
	"${GH_BIN}" api "${environment_endpoint}" -X PUT --input -

if [ "${DRY_RUN:-0}" = '1' ]; then
	run_mutation "${ACTION}" "${GH_BIN}" api "${policy_endpoint}" \
		-X POST -f "name=${TAG_PATTERN}" -f 'type=tag'
	run_mutation_with_input "${ACTION}" "${ruleset_payload}" \
		"${GH_BIN}" api "${ruleset_endpoint}" -X POST --input -
	printf 'GitHub release controls configured\n'
	exit 0
fi

if policy_names="$("${GH_BIN}" api "${policy_endpoint}" --jq '.branch_policies[].name' 2>/dev/null)"; then
	:
else
	status=$?
	printf 'error: unable to inspect deployment policies\n' >&2
	exit "${status}"
fi
if ruleset_id="$("${GH_BIN}" api "${ruleset_endpoint}" --jq ".[] | select(.name == \"${RULESET_NAME}\" and .source_type == \"Repository\") | .id" 2>/dev/null)"; then
	if [ -n "${ruleset_id}" ]; then
		[[ "${ruleset_id}" =~ ^[0-9]+$ ]] || fail 'GitHub returned an invalid ruleset ID'
	fi
else
	status=$?
	printf 'error: unable to inspect repository rulesets\n' >&2
	exit "${status}"
fi

policy_exists=0
while IFS= read -r policy_name; do
	if [ "${policy_name}" = "${TAG_PATTERN}" ]; then
		policy_exists=1
		break
	fi
done <<<"${policy_names}"
if [ "${policy_exists}" -eq 0 ]; then
	run_mutation "${ACTION}" "${GH_BIN}" api "${policy_endpoint}" \
		-X POST -f "name=${TAG_PATTERN}" -f 'type=tag'
fi

if [ -n "${ruleset_id}" ]; then
	run_mutation_with_input "${ACTION}" "${ruleset_payload}" \
		"${GH_BIN}" api "${ruleset_endpoint}/${ruleset_id}" -X PUT --input -
else
	run_mutation_with_input "${ACTION}" "${ruleset_payload}" \
		"${GH_BIN}" api "${ruleset_endpoint}" -X POST --input -
fi

printf 'GitHub release controls configured\n'
