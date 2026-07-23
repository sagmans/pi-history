#!/usr/bin/env bash
# Strict formats make all later quoting and JSON construction non-ambiguous.

readonly PACKAGE_NAME_PATTERN='^@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$'
readonly REPOSITORY_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$'
readonly WORKFLOW_FILE_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$'
readonly ENVIRONMENT_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]*$'
readonly REVIEWER_PATTERN='^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'
readonly TAG_PATTERN_PATTERN='^[A-Za-z0-9._/-]+[*]?$'
readonly VERSION_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$'
readonly PACKAGE_SPEC_PATTERN='^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@[^[:space:];&|`$<>]+$'

fail() {
	printf 'error: %s\n' "$1" >&2
	exit "${2:-1}"
}

validate_package_name() {
	local value="${1:-}"
	[[ "${value}" =~ ${PACKAGE_NAME_PATTERN} ]] || fail 'PKG_NAME must be a lowercase scoped npm package'
}

validate_repository() {
	local value="${1:-}"
	[[ "${value}" =~ ${REPOSITORY_PATTERN} ]] || fail 'REPO must use owner/repository format'
}

validate_workflow_file() {
	local value="${1:-}"
	[[ "${value}" =~ ${WORKFLOW_FILE_PATTERN} ]] || fail 'WORKFLOW_FILE must be a workflow filename ending in .yml or .yaml'
}

validate_environment() {
	local value="${1:-}"
	[[ "${value}" =~ ${ENVIRONMENT_PATTERN} ]] || fail 'ENVIRONMENT contains unsupported characters'
}

validate_reviewer() {
	local value="${1:-}"
	[[ "${value}" =~ ${REVIEWER_PATTERN} ]] || fail 'REVIEWER must be a GitHub login'
}

validate_tag_pattern() {
	local value="${1:-}"
	[[ "${value}" =~ ${TAG_PATTERN_PATTERN} ]] || fail 'TAG_PATTERN contains unsupported characters'
	case "${value}" in
		*'..'* | *'//'*) fail 'TAG_PATTERN contains an unsafe ref path' ;;
	esac
}

validate_version() {
	local value="${1:-}"
	[[ "${value}" =~ ${VERSION_PATTERN} ]] || fail 'PKG_VERSION must be a semantic version'
}

validate_package_spec() {
	local value="${1:-}"
	[[ "${value}" =~ ${PACKAGE_SPEC_PATTERN} ]] || fail 'OLD_PKG_SPEC must include a safe package name and version range'
}

validate_message() {
	local value="${1:-}"
	[ -n "${value}" ] || fail 'DEPRECATION_MESSAGE is required'
	case "${value}" in
		*$'\n'* | *$'\r'*) fail 'DEPRECATION_MESSAGE must be one line' ;;
	esac
}

version_at_least() {
	local current="$1"
	local required="$2"
	local current_major current_minor current_patch
	local required_major required_minor required_patch

	[[ "${current}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
	current_major="${BASH_REMATCH[1]}"
	current_minor="${BASH_REMATCH[2]}"
	current_patch="${BASH_REMATCH[3]}"
	[[ "${required}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
	required_major="${BASH_REMATCH[1]}"
	required_minor="${BASH_REMATCH[2]}"
	required_patch="${BASH_REMATCH[3]}"

	if [ "${current_major}" -ne "${required_major}" ]; then
		[ "${current_major}" -gt "${required_major}" ]
	elif [ "${current_minor}" -ne "${required_minor}" ]; then
		[ "${current_minor}" -gt "${required_minor}" ]
	else
		[ "${current_patch}" -ge "${required_patch}" ]
	fi
}
