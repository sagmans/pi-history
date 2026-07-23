#!/usr/bin/env bash
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_DIR
failures=0

for test_file in "${TEST_DIR}"/*.test.sh; do
	if ! bash "${test_file}"; then
		failures=$((failures + 1))
	fi
done

if [ "${failures}" -ne 0 ]; then
	printf '%s test files failed\n' "${failures}" >&2
	exit 1
fi
