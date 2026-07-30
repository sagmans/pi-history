#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"

readonly TARGET_SCRIPT="${REPO_ROOT}/scripts/release/disposable-smoke.sh"
readonly CANDIDATE_SPEC='git:github.com/sagmans/pi-history@candidate-sha'
HOSTILE_HOME=''
HOSTILE_AGENT_DIR=''
HOSTILE_SESSION_DIR=''
HOSTILE_PACKAGE_DIR=''

write_fake_pi() {
	cat >"${FAKE_BIN}/pi" <<'BASH'
#!/usr/bin/env bash
set -u
printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
	"${HOME}" \
	"${PI_CODING_AGENT_DIR}" \
	"${PI_CODING_AGENT_SESSION_DIR}" \
	"${PI_PACKAGE_DIR}" \
	"${1:-}" \
	"${2:-}" >>"${FAKE_LOG}"

case "${FAKE_PI_MODE:-success}:${1:-}" in
	install-failure:install)
		exit 19
		;;
	runtime-failure:--no-session)
		exit 23
		;;
	interrupt:--no-session)
		kill -TERM "${PPID}"
		exit 0
		;;
esac
BASH
	chmod +x "${FAKE_BIN}/pi"
}

prepare_hostile_profiles() {
	HOSTILE_HOME="${TEST_TMP}/active-home"
	HOSTILE_AGENT_DIR="${TEST_TMP}/active-agent"
	HOSTILE_SESSION_DIR="${TEST_TMP}/active-sessions"
	HOSTILE_PACKAGE_DIR="${TEST_TMP}/active-packages"
	mkdir -p "${HOSTILE_HOME}" "${HOSTILE_AGENT_DIR}" "${HOSTILE_SESSION_DIR}" "${HOSTILE_PACKAGE_DIR}"
	printf '%s\n' 'do-not-touch' >"${HOSTILE_HOME}/marker"
	printf '%s\n' 'do-not-touch' >"${HOSTILE_AGENT_DIR}/marker"
	printf '%s\n' 'do-not-touch' >"${HOSTILE_SESSION_DIR}/marker"
	printf '%s\n' 'do-not-touch' >"${HOSTILE_PACKAGE_DIR}/marker"
	write_fake_pi
}

assert_hostile_profiles_untouched() {
	[[ -f "${HOSTILE_HOME}/marker" ]] || return 1
	[[ -f "${HOSTILE_AGENT_DIR}/marker" ]] || return 1
	[[ -f "${HOSTILE_SESSION_DIR}/marker" ]] || return 1
	[[ -f "${HOSTILE_PACKAGE_DIR}/marker" ]] || return 1
}

# PI_PACKAGE_DIR is pi's own install root, not user storage: the harness must
# pass it through untouched instead of confining it.
assert_package_dir_passed_through() {
	local invocation_count line_number
	invocation_count="$(awk 'END { print NR }' "${FAKE_LOG}")"
	for ((line_number = 1; line_number <= invocation_count; line_number += 1)); do
		read_invocation "${line_number}"
		assert_equal "${INVOCATION_PACKAGE_DIR}" "${HOSTILE_PACKAGE_DIR}" || return 1
	done
}

run_release_smoke() {
	local mode="${1:-success}"
	set +e
	OUTPUT="$(
		env -i \
			PATH="${FAKE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
			HOME="${HOSTILE_HOME}" \
			PI_CODING_AGENT_DIR="${HOSTILE_AGENT_DIR}" \
			PI_CODING_AGENT_SESSION_DIR="${HOSTILE_SESSION_DIR}" \
			PI_PACKAGE_DIR="${HOSTILE_PACKAGE_DIR}" \
			TMPDIR="${TEST_TMP}" \
			FAKE_LOG="${FAKE_LOG}" \
			FAKE_PI_MODE="${mode}" \
			bash "${TARGET_SCRIPT}" "${CANDIDATE_SPEC}" 2>&1
	)"
	STATUS=$?
	set -e
}

read_invocation() {
	local line_number="$1"
	local invocation
	invocation="$(awk -v target="${line_number}" 'NR == target { print; exit }' "${FAKE_LOG}")"
	IFS=$'\t' read -r INVOCATION_HOME INVOCATION_AGENT_DIR INVOCATION_SESSION_DIR INVOCATION_PACKAGE_DIR INVOCATION_COMMAND INVOCATION_ARGUMENT <<<"${invocation}"
}

assert_equal() {
	local actual="$1"
	local expected="$2"
	if [[ "${actual}" != "${expected}" ]]; then
		printf 'expected %s, got %s\n' "${expected}" "${actual}" >&2
		return 1
	fi
}

assert_disposable_root_removed() {
	local disposable_root="$1"
	if [[ -e "${disposable_root}" ]]; then
		printf 'disposable root remains: %s\n' "${disposable_root}" >&2
		return 1
	fi
}

test_success_isolates_full_lifecycle() {
	prepare_hostile_profiles
	run_release_smoke
	assert_success || return 1

	read_invocation 1
	local install_home="${INVOCATION_HOME}"
	local install_agent_dir="${INVOCATION_AGENT_DIR}"
	local install_session_dir="${INVOCATION_SESSION_DIR}"
	local disposable_root
	disposable_root="$(dirname "${install_home}")"
	assert_equal "${INVOCATION_COMMAND}" 'install' || return 1
	assert_equal "${INVOCATION_ARGUMENT}" "${CANDIDATE_SPEC}" || return 1
	assert_equal "${install_agent_dir}" "${disposable_root}/agent" || return 1
	assert_equal "${install_session_dir}" "${disposable_root}/sessions" || return 1
	[[ "${disposable_root}" == "${TEST_TMP}"/pi-history-release-smoke.* ]] || return 1

	local invocation_count
	invocation_count="$(awk 'END { print NR }' "${FAKE_LOG}")"
	assert_equal "${invocation_count}" '3' || return 1
	for line_number in 2 3; do
		read_invocation "${line_number}"
		assert_equal "${INVOCATION_HOME}" "${install_home}" || return 1
		assert_equal "${INVOCATION_AGENT_DIR}" "${install_agent_dir}" || return 1
		assert_equal "${INVOCATION_SESSION_DIR}" "${install_session_dir}" || return 1
		assert_equal "${INVOCATION_COMMAND}" '--no-session' || return 1
		assert_equal "${INVOCATION_ARGUMENT}" '' || return 1
	done
	assert_package_dir_passed_through || return 1
	assert_disposable_root_removed "${disposable_root}" || return 1
	assert_hostile_profiles_untouched
}

assert_failure_cleanup() {
	local mode="$1" expected_status="$2" invocation="$3"
	prepare_hostile_profiles
	run_release_smoke "${mode}"
	assert_status "${expected_status}" || return 1
	read_invocation "${invocation}"
	assert_disposable_root_removed "$(dirname "${INVOCATION_HOME}")" || return 1
	assert_hostile_profiles_untouched
}

test_install_failure_cleans_only_disposable_root() {
	assert_failure_cleanup install-failure 19 1
}

test_runtime_failure_cleans_only_disposable_root() {
	assert_failure_cleanup runtime-failure 23 2
}

test_interruption_cleans_only_disposable_root() {
	assert_failure_cleanup interrupt 143 2
}

run_test 'release smoke isolates install and runtime under one disposable root' test_success_isolates_full_lifecycle
run_test 'release smoke cleans disposable state after install failure' test_install_failure_cleans_only_disposable_root
run_test 'release smoke cleans disposable state after runtime failure' test_runtime_failure_cleans_only_disposable_root
run_test 'release smoke cleans disposable state after interruption' test_interruption_cleans_only_disposable_root
finish_tests
