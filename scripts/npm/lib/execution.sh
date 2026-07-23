#!/usr/bin/env bash
# Mutation wrappers centralize confirmation, dry-run output, and output suppression.

readonly MINIMUM_NPM_VERSION='11.15.0'
readonly NPM_BIN="${NPM_BIN:-npm}"
readonly GH_BIN="${GH_BIN:-gh}"
readonly GIT_BIN="${GIT_BIN:-git}"
readonly NODE_BIN="${NODE_BIN:-node}"

require_command() {
	local command_name="$1"
	command -v "${command_name}" >/dev/null 2>&1 || fail "required command not found: ${command_name}"
}

require_npm_version() {
	local current_version
	if current_version="$("${NPM_BIN}" --version 2>/dev/null)"; then
		:
	else
		local status=$?
		printf 'error: unable to read npm version\n' >&2
		return "${status}"
	fi
	version_at_least "${current_version}" "${MINIMUM_NPM_VERSION}" || fail "npm ${MINIMUM_NPM_VERSION} or newer is required"
}

validate_dry_run() {
	case "${DRY_RUN:-0}" in
		0 | 1) ;;
		*) fail 'DRY_RUN must be 0 or 1' ;;
	esac
}

require_confirmation() {
	local action="$1"
	validate_dry_run
	if [ "${DRY_RUN:-0}" = '1' ]; then
		return
	fi
	[ "${CONFIRM:-}" = "${action}" ] || fail "set CONFIRM=${action} to authorize this mutation"
}

print_command() {
	local prefix="$1"
	shift
	printf '%s' "${prefix}"
	local argument
	for argument in "$@"; do
		printf ' %q' "${argument}"
	done
	printf '\n'
}

run_mutation() {
	local action="$1"
	shift
	require_confirmation "${action}"
	if [ "${DRY_RUN:-0}" = '1' ]; then
		print_command 'dry-run:' "$@"
		return
	fi
	print_command 'running:' "$@"
	if "$@" >/dev/null 2>&1; then
		return
	else
		local status=$?
		printf 'error: command failed\n' >&2
		return "${status}"
	fi
}

run_mutation_with_input() {
	local action="$1"
	local input="$2"
	shift 2
	require_confirmation "${action}"
	if [ "${DRY_RUN:-0}" = '1' ]; then
		print_command 'dry-run:' "$@"
		return
	fi
	print_command 'running:' "$@"
	if "$@" <<<"${input}" >/dev/null 2>&1; then
		return
	else
		local status=$?
		printf 'error: command failed\n' >&2
		return "${status}"
	fi
}
