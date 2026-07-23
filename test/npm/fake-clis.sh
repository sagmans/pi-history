#!/usr/bin/env bash
# Deterministic CLI doubles ensure tests cannot reach npm or GitHub.

write_fake_npm() {
	cat >"${FAKE_BIN}/npm" <<'BASH'
#!/usr/bin/env bash
set -u
{
	printf 'npm'
	for argument in "$@"; do
		printf ' %q' "${argument}"
	done
	printf '\n'
} >>"${FAKE_LOG}"

if [ "${FAKE_FAIL_COMMAND:-}" = "${1:-}" ]; then
	printf '%s\n' "${SECRET_MARKER}" >&2
	exit "${FAKE_FAIL_STATUS:-23}"
fi

case "${1:-}" in
	--version)
		printf '%s\n' "${FAKE_NPM_VERSION:-11.15.0}"
		;;
	whoami)
		printf '%s\n' "${SECRET_MARKER}"
		printf 'authentication-output:%s\n' "${SECRET_MARKER}" >&2
		;;
	view)
		if [ "${2:-}" = "${PKG_NAME:-@example/tool}" ] && [ "${3:-}" = 'name' ]; then
			case "${FAKE_VIEW_MODE:-absent}" in
				absent)
					printf 'npm error code E404\n' >&2
					exit 1
					;;
				exists)
					printf '"%s"\n' "${2:-}"
					;;
				unknown)
					printf 'network failure: %s\n' "${SECRET_MARKER}" >&2
					exit 7
					;;
				spoofed)
					printf 'proxy error mentions E404\n' >&2
					exit 7
					;;
			esac
		else
			if [ -n "${FAKE_METADATA_JSON+x}" ]; then
				printf '%s\n' "${FAKE_METADATA_JSON}"
			else
				printf '%s\n' '{"name":"@example/tool","version":"1.2.3","repository":{"url":"git+https://github.com/example/tool.git"},"dist":{"integrity":"sha512-synthetic","shasum":"0123456789abcdef"}}'
			fi
		fi
		;;
	trust)
		if [ "${2:-}" = 'list' ]; then
			if [ -n "${FAKE_TRUST_JSON+x}" ]; then
				printf '%s\n' "${FAKE_TRUST_JSON}"
			else
				printf '%s\n' '[{"id":"synthetic-id","type":"github","file":"release.yml","repository":"example/tool","environment":"npm-release","permissions":["createPackage"]}]'
			fi
		fi
		;;
	access)
		if [ "${2:-}" = 'get' ]; then
			if [ -n "${FAKE_ACCESS_JSON+x}" ]; then
				printf '%s\n' "${FAKE_ACCESS_JSON}"
			else
				printf '%s\n' '{"@example/tool":"public"}'
			fi
		fi
		;;
esac
BASH
}

write_fake_gh() {
	cat >"${FAKE_BIN}/gh" <<'BASH'
#!/usr/bin/env bash
set -u
{
	printf 'gh'
	for argument in "$@"; do
		printf ' %q' "${argument}"
	done
	printf '\n'
} >>"${FAKE_LOG}"

if [ "${FAKE_FAIL_COMMAND:-}" = 'gh' ]; then
	printf '%s\n' "${SECRET_MARKER}" >&2
	exit "${FAKE_FAIL_STATUS:-29}"
fi

case "${1:-}" in
	auth)
		printf '%s\n' "${SECRET_MARKER}"
		printf 'authentication-output:%s\n' "${SECRET_MARKER}" >&2
		;;
	api)
		if [ "${FAKE_FAIL_ENDPOINT:-}" = "${2:-}" ]; then
			printf '%s\n' "${SECRET_MARKER}" >&2
			exit "${FAKE_FAIL_STATUS:-29}"
		fi
		case "${2:-}" in
			repos/*/environments/*)
				case " $* " in
					*' -X PUT '*) : >"${FAKE_GH_STATE_FILE}" ;;
				 esac
				;;
		esac
		case "${2:-}" in
			users/*)
				printf '%s\n' "${FAKE_REVIEWER_ID:-123}"
				;;
			*/deployment-branch-policies)
				case " $* " in
					*' -X '*) ;;
					*)
						if [ "${FAKE_ENVIRONMENT_ABSENT:-0}" = '1' ] && [ ! -f "${FAKE_GH_STATE_FILE}" ]; then
							exit 44
						fi
						printf '%s' "${FAKE_POLICY_NAMES:-}"
						;;
				esac
				;;
			*/rulesets)
				case " $* " in
					*' -X '*) ;;
					*) printf '%s' "${FAKE_RULESET_ID:-}" ;;
				esac
				;;
		esac
		case " $* " in
			*' --input - '*)
				printf '%s\n' '--- payload ---' >>"${FAKE_PAYLOAD_LOG}"
				cat >>"${FAKE_PAYLOAD_LOG}"
				;;
		esac
		;;
esac
BASH
}

write_fake_git() {
	cat >"${FAKE_BIN}/git" <<'BASH'
#!/usr/bin/env bash
set -u
{
	printf 'git'
	for argument in "$@"; do
		printf ' %q' "${argument}"
	done
	printf '\n'
} >>"${FAKE_LOG}"

if [ "${FAKE_FAIL_COMMAND:-}" = 'git' ]; then
	exit "${FAKE_FAIL_STATUS:-31}"
fi
if [ "${1:-}" = 'status' ]; then
	printf '%s' "${FAKE_GIT_STATUS:-}"
fi
BASH
}
