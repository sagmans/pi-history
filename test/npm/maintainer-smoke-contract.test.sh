#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"

readonly SMOKE_SCRIPT="${REPO_ROOT}/scripts/maintainer-smoke-herdr.sh"
readonly STORE_SOURCE="${REPO_ROOT}/src/history-store.ts"

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
	local script
	script="$(cat "${SMOKE_SCRIPT}")"
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
}

run_test 'smoke native fixture matches the runtime schema' test_native_fixture_matches_runtime_schema
run_test 'smoke native fixture carries clear-lineage metadata' test_native_fixture_carries_clear_lineage_metadata
run_test 'smoke legacy fixture is explicitly legacy schema' test_legacy_fixture_is_explicitly_legacy_schema
run_test 'smoke exercises capture, confirmed clear, and restart' test_smoke_exercises_capture_clear_and_restart
finish_tests
