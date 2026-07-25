#!/usr/bin/env bash
# Keep every Pi-owned path inside one root so release checks cannot reach an
# inherited maintainer profile, even when Pi storage overrides are already set.
set -euo pipefail

readonly ROOT_TEMPLATE='pi-history-release-smoke.XXXXXX'
readonly HOME_DIR_NAME='home'
readonly AGENT_DIR_NAME='agent'
readonly SESSION_DIR_NAME='sessions'
readonly NO_SESSION_FLAG='--no-session'
readonly EXIT_INTERRUPT='130'
readonly EXIT_TERMINATE='143'
readonly PRIVATE_UMASK='077'

disposable_root=''

cleanup() {
	local exit_code=$?
	trap - EXIT INT TERM
	if [[ -n "${disposable_root}" && -d "${disposable_root}" ]]; then
		rm -rf -- "${disposable_root}" || {
			printf 'Unable to remove disposable release-smoke state\n' >&2
			[[ "${exit_code}" -ne 0 ]] || exit_code=1
		}
	fi
	exit "${exit_code}"
}
trap cleanup EXIT
trap 'exit "${EXIT_INTERRUPT}"' INT
trap 'exit "${EXIT_TERMINATE}"' TERM

fail() {
	printf 'pi-history release smoke failed: %s\n' "$1" >&2
	exit 1
}

[[ "$#" -eq 1 && -n "$1" && "$1" != -* ]] || fail 'pass one candidate package spec'
command -v pi >/dev/null 2>&1 || fail 'pi is not available'
readonly candidate_spec="$1"

umask "${PRIVATE_UMASK}"
disposable_root="$(mktemp -d "${TMPDIR:-/tmp}/${ROOT_TEMPLATE}")"
export HOME="${disposable_root}/${HOME_DIR_NAME}"
export PI_CODING_AGENT_DIR="${disposable_root}/${AGENT_DIR_NAME}"
export PI_CODING_AGENT_SESSION_DIR="${disposable_root}/${SESSION_DIR_NAME}"
export PI_SKIP_VERSION_CHECK='1'
export PI_TELEMETRY='0'
mkdir -p -- "${HOME}" "${PI_CODING_AGENT_DIR}" "${PI_CODING_AGENT_SESSION_DIR}"
# PI_PACKAGE_DIR is pi's own install root: pi resolves builtin assets (themes)
# from it, and user state already stays under the agent directory, so the
# harness must leave it untouched rather than confine it.

pi install "${candidate_spec}"

printf '%s\n' \
	'Disposable Pi launch 1/2: capture synthetic prompts, verify completion, then /exit.' \
	'Never enter real prompts or copy history from another profile.'
pi "${NO_SESSION_FLAG}"

printf '%s\n' \
	'Disposable Pi launch 2/2: verify restart persistence and /pi-history status,' \
	'then run /pi-history clear, Ctrl+R, ghost completion or its graceful fallback, and /exit.'
pi "${NO_SESSION_FLAG}"
