#!/usr/bin/env bash
# Single source of truth for shell linting and formatting across pre-commit and
# pre-push hooks, keeping file discovery, exclusions, and flags aligned.
# scripts/setup-hooks is a shared template file, so it is linted without reformatting.
set -euo pipefail

readonly SHELL_LIST_PREFIX=pi-shell-list

for tool in shellcheck shfmt; do
	command -v "$tool" >/dev/null || {
		echo "lint-shell: $tool is missing; install it before checking shell scripts" >&2
		exit 1
	}
done

cd -- "$(dirname -- "$0")/.."

list=$(mktemp "${TMPDIR:-/tmp}/$SHELL_LIST_PREFIX.XXXXXX")
cleanup() {
	# Only this run's temporary list file is removed.
	if [[ -n "${list:-}" && "${list##*/}" == "$SHELL_LIST_PREFIX".* ]]; then
		rm -f -- "$list"
	fi
}
trap cleanup EXIT

if [[ -e .git ]]; then
	git ls-files -z -- '*.sh' '.githooks/*.d/*' ':!.githooks/lib' >"$list"
else
	find . -path ./.githooks/lib -prune \
		-o \( -name '*.sh' -o -path './.githooks/*.d/*' \) -type f -print0 >"$list"
fi

files=()
while IFS= read -r -d '' file; do
	file=${file#./}
	[[ -n "$file" ]] && files+=("$file")
done <"$list"

[[ ${#files[@]} -gt 0 ]] || {
	echo "lint-shell: no tracked shell scripts found" >&2
	exit 1
}

lint_targets=("${files[@]}")
[[ -f scripts/setup-hooks ]] && lint_targets=(scripts/setup-hooks "${lint_targets[@]}")

shellcheck -x -- "${lint_targets[@]}"
shfmt -d -- "${files[@]}"
