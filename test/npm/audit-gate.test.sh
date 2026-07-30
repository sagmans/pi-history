#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_DIR
readonly GATE="${TEST_DIR}/../../scripts/npm/audit-gate.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf -- "${TMP}"' EXIT

write_fixture() {
	printf '%s' "$1" >"${TMP}/audit.json"
}

assert_status() {
	local expected="$1"
	set +e
	output="$(node "${GATE}" --fixture "${TMP}/audit.json" 2>&1)"
	status=$?
	set -e
	if [ "${status}" -ne "${expected}" ]; then
		printf 'not ok - %s (expected %s, got %s)\n' "${test_name}" "${expected}" "${status}" >&2
		return 1
	fi
	printf 'ok - %s\n' "${test_name}"
}

assert_output_contains() {
	local needle="$1"
	case "${output}" in
	*"${needle}"*)
		printf 'ok - %s reports %s\n' "${test_name}" "${needle}"
		;;
	*)
		printf 'not ok - %s missing %s in output\n' "${test_name}" "${needle}" >&2
		return 1
		;;
	esac
}

WAIVED_NODE='node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion'

vuln_entry() {
	local name="$1" severity="$2" url="$3" node="$4"
	cat <<JSON
"${name}": {
  "name": "${name}",
  "severity": "${severity}",
  "via": [{"url": "${url}"}],
  "nodes": ["${node}"]
}
JSON
}

test_name='clean report passes'
write_fixture '{"vulnerabilities": {}}'
assert_status 0

test_name='only waived advisory passes'
write_fixture "{\"vulnerabilities\": {$(vuln_entry brace-expansion high 'https://github.com/advisories/GHSA-mh99-v99m-4gvg' "${WAIVED_NODE}")}}"
assert_status 0
assert_output_contains '1 waived'

test_name='same advisory at a different path fails'
write_fixture "{\"vulnerabilities\": {$(vuln_entry brace-expansion high 'https://github.com/advisories/GHSA-mh99-v99m-4gvg' 'node_modules/brace-expansion')}}"
assert_status 1

test_name='waived advisory without install nodes fails'
write_fixture '{"vulnerabilities":{"brace-expansion":{"name":"brace-expansion","severity":"high","via":[{"url":"https://github.com/advisories/GHSA-mh99-v99m-4gvg"}]}}}'
assert_status 1

test_name='waived advisory with empty install nodes fails'
write_fixture '{"vulnerabilities":{"brace-expansion":{"name":"brace-expansion","severity":"high","via":[{"url":"https://github.com/advisories/GHSA-mh99-v99m-4gvg"}],"nodes":[]}}}'
assert_status 1

test_name='waived advisory mixed with another install path fails'
write_fixture "{\"vulnerabilities\":{\"brace-expansion\":{\"name\":\"brace-expansion\",\"severity\":\"high\",\"via\":[{\"url\":\"https://github.com/advisories/GHSA-mh99-v99m-4gvg\"}],\"nodes\":[\"${WAIVED_NODE}\",\"node_modules/brace-expansion\"]}}}"
assert_status 1

test_name='waived advisory mixed with another object advisory fails'
write_fixture "{\"vulnerabilities\":{\"brace-expansion\":{\"name\":\"brace-expansion\",\"severity\":\"high\",\"via\":[{\"url\":\"https://github.com/advisories/GHSA-mh99-v99m-4gvg\"},{\"url\":\"https://github.com/advisories/GHSA-other\"}],\"nodes\":[\"${WAIVED_NODE}\"]}}}"
assert_status 1

test_name='unwaived high advisory fails'
write_fixture "{\"vulnerabilities\": {$(vuln_entry brace-expansion high 'https://github.com/advisories/GHSA-mh99-v99m-4gvg' "${WAIVED_NODE}"), $(vuln_entry protobufjs high 'https://github.com/advisories/GHSA-j3f2-48v5-ccww' 'node_modules/protobufjs')}}"
assert_status 1
assert_output_contains 'protobufjs'

test_name='critical advisory fails'
write_fixture "{\"vulnerabilities\": {$(vuln_entry other critical 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz' 'node_modules/other')}}"
assert_status 1

test_name='moderate advisory passes'
write_fixture "{\"vulnerabilities\": {$(vuln_entry protobufjs moderate 'https://github.com/advisories/GHSA-j3f2-48v5-ccww' 'node_modules/protobufjs')}}"
assert_status 0

printf '12 tests, 0 failures\n'
