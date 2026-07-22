#!/usr/bin/env bash
# One-time GitHub-side setup for npm OIDC trusted-publishing releases.
# Reusable across repos: provisions everything gh-side so that only the
# named reviewer can publish, with no stored secrets anywhere.
#
# Creates/updates:
#   1. Environment "npm-release" — required reviewer, deploys restricted to
#      release tags, admins cannot bypass the approval gate.
#   2. Tag deployment policy on that environment for the tag pattern.
#   3. Ruleset restricting create/update/delete of release tags to repo admins.
#
# Prerequisites: gh CLI authenticated with admin rights on the repo.
# Usage: setup-github-oidc-release.sh <owner/repo> <reviewer-login> [tag-pattern]
set -euo pipefail

readonly REPO="${1:?usage: setup-github-oidc-release.sh <owner/repo> <reviewer-login> [tag-pattern]}"
readonly REVIEWER="${2:?reviewer login required}"
readonly TAG_PATTERN="${3:-v*}"
readonly ENV_NAME="npm-release"
readonly RULESET_NAME="release-tags-admin-only"
# RepositoryRole 5 = admin: only admins may create/move release tags.
readonly ADMIN_ROLE_ID=5

reviewer_id="$(gh api "users/${REVIEWER}" --jq '.id')"

# PUT is upsert: safe to re-run. can_admins_bypass=false keeps the approval
# gate mandatory even for repo admins.
gh api "repos/${REPO}/environments/${ENV_NAME}" -X PUT --input - >/dev/null <<EOF
{
  "can_admins_bypass": false,
  "reviewers": [{"type": "User", "id": ${reviewer_id}}],
  "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}
}
EOF

# Skip if the tag policy already exists; the API does not deduplicate.
if ! gh api "repos/${REPO}/environments/${ENV_NAME}/deployment-branch-policies" \
	--jq ".branch_policies[].name" | grep -qx "${TAG_PATTERN}"; then
	gh api "repos/${REPO}/environments/${ENV_NAME}/deployment-branch-policies" \
		-X POST -f "name=${TAG_PATTERN}" -f "type=tag" >/dev/null
fi

# PUT (update) when the ruleset exists, POST (create) otherwise.
ruleset_payload() {
	cat <<EOF
{
  "name": "${RULESET_NAME}",
  "target": "tag",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/tags/${TAG_PATTERN}"], "exclude": []}},
  "rules": [{"type": "creation"}, {"type": "update"}, {"type": "deletion"}],
  "bypass_actors": [{"actor_id": ${ADMIN_ROLE_ID}, "actor_type": "RepositoryRole", "bypass_mode": "always"}]
}
EOF
}

ruleset_id="$(gh api "repos/${REPO}/rulesets" --jq ".[] | select(.name == \"${RULESET_NAME}\" and .source_type == \"Repository\") | .id" | head -1)"
if [ -n "${ruleset_id}" ]; then
	gh api "repos/${REPO}/rulesets/${ruleset_id}" -X PUT --input <(ruleset_payload) >/dev/null
else
	gh api "repos/${REPO}/rulesets" -X POST --input <(ruleset_payload) >/dev/null
fi

echo "done: ${REPO} — env ${ENV_NAME} (reviewer: ${REVIEWER}), tag policy ${TAG_PATTERN}, ruleset ${RULESET_NAME}"
