#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_DIR
REPO_ROOT="$(cd "${TEST_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly SMOKE_SCRIPT="${REPO_ROOT}/scripts/maintainer-smoke-herdr.sh"
readonly STORE_SOURCE="${REPO_ROOT}/src/history-store.ts"
readonly HEALTHY_DIAGNOSTIC='pi-history: diagnosticsVersion=2; state=healthy; initialization=ready; storage=ready; editor=ready; entries=0; cap=42; scope=global'
readonly WRAPPED_HEALTHY_DIAGNOSTIC="${HEALTHY_DIAGNOSTIC/storage=ready/$'storage=r\neady'}"
readonly DIAGNOSTIC_SUFFIX_CANARY='PRIVATE_SUFFIX_CANARY'

smoke_constant() {
	local name="$1"
	sed -n "s/^readonly ${name}=\"\([0-9][0-9]*\)\"/\1/p" "${SMOKE_SCRIPT}"
}

runtime_schema_version() {
	sed -n 's/^export const HISTORY_SCHEMA_VERSION = \([0-9][0-9]*\);/\1/p' "${STORE_SOURCE}"
}

test_native_fixture_matches_runtime_schema() {
	local smoke_version runtime_version
	smoke_version="$(smoke_constant HISTORY_SCHEMA_VERSION)"
	runtime_version="$(runtime_schema_version)"
	if [[ -z "${smoke_version}" || "${smoke_version}" != "${runtime_version}" ]]; then
		printf 'smoke native fixture schema %s does not match runtime schema %s\n' \
			"${smoke_version:-missing}" "${runtime_version}" >&2
		return 1
	fi
}

test_native_fixture_carries_clear_lineage_metadata() {
	grep -q '"clearEpoch": null' "${SMOKE_SCRIPT}" || {
		printf 'smoke native fixture lacks required clearEpoch lineage field\n' >&2
		return 1
	}
}

test_legacy_fixture_is_explicitly_legacy_schema() {
	[[ "$(smoke_constant LEGACY_HISTORY_SCHEMA_VERSION)" == '1' ]] || {
		printf 'smoke legacy fixture is not pinned to legacy schema 1\n' >&2
		return 1
	}
}

test_smoke_exercises_capture_clear_and_restart() {
	local script restart_section
	script="$(cat "${SMOKE_SCRIPT}")"
	restart_section="$(sed -n '/^# Restart persistence:/,/^printf .*Herdr smoke passed:/p' "${SMOKE_SCRIPT}")"
	[[ "${script}" == *'/pi-history clear'* ]] || {
		printf 'smoke does not exercise a confirmed clear\n' >&2
		return 1
	}
	[[ "${script}" == *'CAPTURE_CANARY'* ]] || {
		printf 'smoke does not exercise one synthetic capture\n' >&2
		return 1
	}
	[[ "${script}" == *'check_history_file'* ]] || {
		printf 'smoke lacks the on-disk native contract check\n' >&2
		return 1
	}
	[[ "${restart_section}" == *'herdr agent prompt "$agent" "/quit"'* &&
		"${restart_section}" == *'wait_for_shell'* &&
		"${restart_section}" == *'start_agent'* &&
		"${restart_section}" == *'run_status_check "$SMOKE_ENTRIES_AFTER_CLEAR"'* ]] || {
		printf 'smoke does not exercise a synchronized restart check\n' >&2
		return 1
	}
}

test_diagnostic_extraction_enforces_contract_boundary() {
	eval "$(sed -n '/^extract_diagnostic() {$/,/^}$/p' "${SMOKE_SCRIPT}")"
	local extracted
	extracted="$(
		printf '%s' "${HEALTHY_DIAGNOSTIC}" |
			extract_diagnostic "${HEALTHY_DIAGNOSTIC}"
	)" || {
		printf 'smoke diagnostic extraction rejected an exact line\n' >&2
		return 1
	}
	[[ "${extracted}" == "${HEALTHY_DIAGNOSTIC}" ]] || {
		printf 'smoke diagnostic extraction changed an exact line\n' >&2
		return 1
	}
	extracted="$(
		printf '%s' "${WRAPPED_HEALTHY_DIAGNOSTIC}" |
			extract_diagnostic "${HEALTHY_DIAGNOSTIC}"
	)" || {
		printf 'smoke diagnostic extraction rejected a physical wrap\n' >&2
		return 1
	}
	[[ "${extracted}" == "${HEALTHY_DIAGNOSTIC}" ]] || {
		printf 'smoke diagnostic extraction changed a physically wrapped line\n' >&2
		return 1
	}
	if printf '%s; %s' "${HEALTHY_DIAGNOSTIC}" "${DIAGNOSTIC_SUFFIX_CANARY}" |
		extract_diagnostic "${HEALTHY_DIAGNOSTIC}" >/dev/null; then
		printf 'smoke diagnostic extraction accepted a private suffix\n' >&2
		return 1
	fi
}

test_native_fixture_matches_runtime_schema
test_native_fixture_carries_clear_lineage_metadata
test_legacy_fixture_is_explicitly_legacy_schema
test_smoke_exercises_capture_clear_and_restart
test_diagnostic_extraction_enforces_contract_boundary
printf '5 tests passed\n'
