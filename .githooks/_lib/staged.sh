# shellcheck shell=sh
# Shared by this repository's pre-commit.d scripts. Sourced relative to the
# script's own path: . "$(dirname -- "$0")/../_lib/staged.sh"
# staged_tree writes the content being committed (the hook's index, never the
# working tree) into a private temporary directory, links the clone's
# installed node_modules into it, and sets st_tree to its path. The directory
# is removed when the script exits.
st_tmp=''
st_cleanup() { [ -z "$st_tmp" ] || rm -rf -- "$st_tmp"; }
trap st_cleanup EXIT
trap 'st_cleanup; exit 1' HUP INT TERM
staged_tree() {
	st_top=$(git rev-parse --show-toplevel) || return 1
	st_tmp=$(mktemp -d "${TMPDIR:-/tmp}/hook-staged.XXXXXX") || return 1
	st_tree="$st_tmp/tree"
	staged_git checkout-index -a -q --prefix="$st_tree/" || return 1
	if [ -d "$st_top/node_modules" ]; then
		ln -s "$st_top/node_modules" "$st_tree/node_modules" || return 1
	fi
}
