# shellcheck shell=sh
# Shared by this repository's pre-push.d scripts. Each script sources it
# relative to its own path, so the dispatcher's reviewed copy is used, never
# the live working tree:
#   . "$(dirname -- "$0")/../_lib/prepush.sh"
# The caller sources $HOOK_HELPERS first and defines checks(); run_pushed
# then runs checks() once in the tree of every pushed commit.

pp_top=$(git rev-parse --show-toplevel) || exit 1

# Dependencies when at_sha runs in a temporary worktree of the pushed commit:
# installed from that commit's committed lockfile only, never resolved. npm
# skips lifecycle scripts; pnpm runs only the builds the repository allowlists
# in pnpm-workspace.yaml (allowBuilds, exact names; strictDepBuilds fails on
# any other build script), under its minimumReleaseAge. In place (the pushed
# commit is a clean HEAD) the clone's own install is used. A script sets
# root_deps=no when it installs its own dependency set.
install_deps() {
	[ "${root_deps:-yes}" = yes ] || return 0
	[ "$(pwd -P)" != "$(CDPATH='' cd -- "$pp_top" && pwd -P)" ] || return 0
	if [ -f pnpm-lock.yaml ]; then
		pnpm install --frozen-lockfile >/dev/null || return 1
	elif [ -f package-lock.json ]; then
		npm ci --ignore-scripts --no-audit --no-fund >/dev/null || return 1
	fi
}

# at_sha runs its command with set -e off, so every step returns explicitly.
run_at() {
	install_deps || return 1
	checks || return 1
}

run_pushed() {
	: "${HOOK_STDIN_FILE:?HOOK_STDIN_FILE is not set: run this hook through the dotf git hooks dispatcher}"
	# Tags carry no new branch commits and are not tested; pushed_shas
	# (dotf rev 4) skips deletions only. grep exits 1 when every line is a
	# tag, which is fine; anything else is an error and blocks the push.
	pp_lines=$(grep -v -e '^refs/tags/' -e ' refs/tags/[^ ]* [^ ]*$' <"$HOOK_STDIN_FILE") || [ $? -eq 1 ] || {
		echo "pre-push: $(basename -- "$0"): cannot read the pushed refs" >&2
		exit 1
	}
	# Captured, never piped into a loop: a failure inside `| while` only
	# leaves the subshell. pushed_shas fails on a malformed line, and that
	# failure blocks the push. Each commit is tested once.
	pp_shas=$(printf '%s\n' "$pp_lines" | pushed_shas) || {
		echo "pre-push: $(basename -- "$0"): cannot parse the pushed refs" >&2
		exit 1
	}
	pp_shas=$(printf '%s\n' "$pp_shas" | sort -u)
	if [ -z "$pp_shas" ]; then
		echo "pre-push: $(basename -- "$0"): nothing to check (only deletes or tags pushed)" >&2
		exit 0
	fi
	# The helpers use sha, tmp and rc themselves, so the loop uses its own name.
	for pp_commit in $pp_shas; do
		echo "pre-push: $(basename -- "$0"): checking $pp_commit" >&2
		at_sha "$pp_commit" run_at || {
			echo "pre-push: $(basename -- "$0"): checks failed for $pp_commit" >&2
			exit 1
		}
	done
}
