#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_DIR
REPO_ROOT="$(cd "${TEST_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly DEFAULT_PACKAGE='@example/tool'
readonly DEFAULT_REPOSITORY='example/tool'
readonly DEFAULT_VERSION='1.2.3'
readonly DEFAULT_WORKFLOW='release.yml'
readonly DEFAULT_ENVIRONMENT='npm-release'
readonly DEFAULT_REVIEWER='release-owner'
readonly DEFAULT_TAG_PATTERN='v*'
readonly SECRET_MARKER='secret-auth-marker'
REAL_NODE_BIN="$(command -v node)"
readonly REAL_NODE_BIN
# shellcheck source=test/npm/fake-clis.sh
source "${TEST_DIR}/fake-clis.sh"

TEST_COUNT=0
TEST_FAILURES=0
TEST_TMP=''
FAKE_BIN=''
FAKE_LOG=''
FAKE_PAYLOAD_LOG=''
OUTPUT=''
STATUS=0

setup_fixture() {
	TEST_TMP="$(mktemp -d)"
	FAKE_BIN="${TEST_TMP}/bin"
	FAKE_LOG="${TEST_TMP}/cli.log"
	FAKE_PAYLOAD_LOG="${TEST_TMP}/payload.log"
	mkdir -p "${FAKE_BIN}" "${TEST_TMP}/project/.github/workflows" "${TEST_TMP}/home"
	: >"${FAKE_LOG}"
	: >"${FAKE_PAYLOAD_LOG}"

	cat >"${TEST_TMP}/project/package.json" <<'JSON'
{
  "name": "@example/tool",
  "version": "1.2.3",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/example/tool.git"
  },
  "publishConfig": {
    "access": "public"
  }
}
JSON

	write_valid_workflow
	write_fake_npm
	write_fake_gh
	write_fake_git
	chmod +x "${FAKE_BIN}/npm" "${FAKE_BIN}/gh" "${FAKE_BIN}/git"
}

teardown_fixture() {
	if [ -n "${TEST_TMP}" ]; then
		rm -rf -- "${TEST_TMP}"
	fi
	TEST_TMP=''
}

write_valid_workflow() {
	cat >"${TEST_TMP}/project/.github/workflows/${DEFAULT_WORKFLOW}" <<'YAML'
name: release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    environment: npm-release
    permissions:
      contents: read
      id-token: write
    steps:
      - run: npm publish --provenance --access public
YAML
}

run_script_path() {
	local script_path="$1"
	shift
	set +e
	OUTPUT="$(
		cd "${TEST_TMP}/project" &&
			env -i \
				PATH="${FAKE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
				HOME="${TEST_TMP}/home" \
				TMPDIR="${TEST_TMP}" \
				FAKE_LOG="${FAKE_LOG}" \
				FAKE_PAYLOAD_LOG="${FAKE_PAYLOAD_LOG}" \
				FAKE_GH_STATE_FILE="${TEST_TMP}/gh-state" \
				SECRET_MARKER="${SECRET_MARKER}" \
				NODE_BIN="${REAL_NODE_BIN}" \
				PKG_NAME="${DEFAULT_PACKAGE}" \
				PKG_VERSION="${DEFAULT_VERSION}" \
				REPO="${DEFAULT_REPOSITORY}" \
				WORKFLOW_FILE="${DEFAULT_WORKFLOW}" \
				ENVIRONMENT="${DEFAULT_ENVIRONMENT}" \
				REVIEWER="${DEFAULT_REVIEWER}" \
				TAG_PATTERN="${DEFAULT_TAG_PATTERN}" \
				DRY_RUN=0 \
				"$@" \
				bash "${script_path}" 2>&1
	)"
	STATUS=$?
	set -e
}

run_target() {
	local script_name="$1"
	shift
	run_script_path "${REPO_ROOT}/scripts/npm/${script_name}" "$@"
}

assert_success() {
	if [ "${STATUS}" -ne 0 ]; then
		printf 'expected success, got %s\n%s\n' "${STATUS}" "${OUTPUT}" >&2
		return 1
	fi
}

assert_status() {
	local expected="$1"
	if [ "${STATUS}" -ne "${expected}" ]; then
		printf 'expected status %s, got %s\n%s\n' "${expected}" "${STATUS}" "${OUTPUT}" >&2
		return 1
	fi
}

assert_failure() {
	if [ "${STATUS}" -eq 0 ]; then
		printf 'expected failure\n%s\n' "${OUTPUT}" >&2
		return 1
	fi
}

assert_contains() {
	local haystack="$1"
	local needle="$2"
	case "${haystack}" in
		*"${needle}"*) ;;
		*)
			printf 'missing text: %s\n%s\n' "${needle}" "${haystack}" >&2
			return 1
			;;
	esac
}

assert_not_contains() {
	local haystack="$1"
	local needle="$2"
	case "${haystack}" in
		*"${needle}"*)
			printf 'unexpected text: %s\n%s\n' "${needle}" "${haystack}" >&2
			return 1
			;;
		*) ;;
	esac
}

read_fake_log() {
	# shellcheck disable=SC2034
	FAKE_LOG_CONTENT="$(<"${FAKE_LOG}")"
}

read_payload_log() {
	# shellcheck disable=SC2034
	FAKE_PAYLOAD_CONTENT="$(<"${FAKE_PAYLOAD_LOG}")"
}

run_test() {
	local test_name="$1"
	local test_function="$2"
	TEST_COUNT=$((TEST_COUNT + 1))
	setup_fixture
	if "${test_function}"; then
		printf 'ok - %s\n' "${test_name}"
	else
		printf 'not ok - %s\n' "${test_name}" >&2
		TEST_FAILURES=$((TEST_FAILURES + 1))
	fi
	teardown_fixture
}

finish_tests() {
	if [ "${TEST_FAILURES}" -ne 0 ]; then
		printf '%s/%s tests failed\n' "${TEST_FAILURES}" "${TEST_COUNT}" >&2
		exit 1
	fi
	printf '%s tests passed\n' "${TEST_COUNT}"
}
