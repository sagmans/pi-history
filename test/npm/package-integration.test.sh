#!/usr/bin/env bash
set -euo pipefail

TEST_SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SUPPORT_DIR
# shellcheck source=test/npm/test-helper.sh
source "${TEST_SUPPORT_DIR}/test-helper.sh"

test_npm_test_runs_shell_suite() {
	local npm_test shell_test
	npm_test="$(cd "${REPO_ROOT}" && "${REAL_NODE_BIN}" -p 'require("./package.json").scripts.test')"
	shell_test="$(cd "${REPO_ROOT}" && "${REAL_NODE_BIN}" -p 'require("./package.json").scripts["test:npm"] ?? ""')"
	[ "${shell_test}" = 'bash test/npm/run.sh' ] || return 1
	case "${npm_test}" in
		*'npm run test:npm'*) ;;
		*) return 1 ;;
	esac
}

run_test 'npm test includes the shell suite' test_npm_test_runs_shell_suite
finish_tests
