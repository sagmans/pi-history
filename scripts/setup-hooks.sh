#!/bin/sh
# Installs the hook router for this clone and points the repo-local
# core.hooksPath at it with an ABSOLUTE path.
#
# Why a router instead of core.hooksPath=.githooks: the setting is shared by
# every branch and worktree. A relative path resolves to nothing on a branch or
# worktree that predates .githooks, and Git would then run no hooks at all,
# global ones included. The router lives in the Git common directory, so it
# exists everywhere: it runs the worktree's .githooks/<hook> when present
# (which chains the global hook first) and otherwise the global hook alone.
# Global hooks and global configuration are never modified.
# Run once per clone; in a bare repository with worktrees, run it from any
# worktree (the router and setting are shared). Rerun after adding a hook.
set -eu
HOOKS_DIR='.githooks'
ROUTER_DIR_NAME='project-hooks'
ROUTER_SOURCE="$HOOKS_DIR/_lib/dispatch.sh"
# Hook names routed even when absent from .githooks, so global guards always run.
BASE_HOOKS='pre-commit prepare-commit-msg commit-msg pre-push'

top=$(git rev-parse --show-toplevel)
common=$(CDPATH='' cd -- "$(git rev-parse --git-common-dir)" && pwd -P)
router="$common/$ROUTER_DIR_NAME"
global=$(git config --global --includes --type=path --get core.hooksPath 2>/dev/null || true)

names=$BASE_HOOKS
for f in "$top/$HOOKS_DIR"/* ${global:+"$global"/*}; do
	[ -f "$f" ] && [ -x "$f" ] || continue
	names="$names $(basename -- "$f")"
done

mkdir -p "$router"
printf '%s\n' "$HOOKS_DIR" >"$router/project-dir"
for n in $(printf '%s\n' $names | sort -u); do
	case "$n" in *.*) continue ;; esac
	cp "$top/$ROUTER_SOURCE" "$router/$n"
	chmod +x "$router/$n"
done
git -C "$top" config --local core.hooksPath "$router"
echo "core.hooksPath=$router (global hooks still run first)"
