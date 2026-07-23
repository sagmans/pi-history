#!/usr/bin/env bash
# Local project checks prevent registry identity drift and dirty-source publication.

require_workflow() {
	local workflow_file="$1"
	[ -f ".github/workflows/${workflow_file}" ] || fail 'configured workflow file does not exist'
}

require_clean_worktree() {
	local status_output
	if status_output="$("${GIT_BIN}" status --porcelain --untracked-files=all 2>/dev/null)"; then
		[ -z "${status_output}" ] || fail 'working tree must be clean'
	else
		local status=$?
		printf 'error: unable to inspect working tree\n' >&2
		return "${status}"
	fi
}

validate_package_metadata() {
	local package_name="$1"
	local repository="$2"
	"${NODE_BIN}" --input-type=module - "${package_name}" "${repository}" <<'NODE'
import fs from "node:fs";

const expectedName = process.argv[2];
const expectedRepository = process.argv[3];
const reject = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};
let metadata;
try {
  metadata = JSON.parse(fs.readFileSync("package.json", "utf8"));
} catch {
  reject("package.json must contain valid JSON");
}
const repositoryUrl = typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url;
const acceptedRepositories = new Set([
  `git+https://github.com/${expectedRepository}.git`,
  `https://github.com/${expectedRepository}.git`,
  `https://github.com/${expectedRepository}`,
  `git@github.com:${expectedRepository}.git`,
]);

if (metadata.name !== expectedName) reject("package.json name does not match PKG_NAME");
if (metadata.private === true) reject("package.json marks the package private");
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[+-][0-9A-Za-z.-]+)?$/.test(metadata.version ?? "")) {
  reject("package.json version must be semantic");
}
if (!acceptedRepositories.has(repositoryUrl)) reject("package.json repository does not match REPO");
if (metadata.publishConfig?.access && metadata.publishConfig.access !== "public") {
  reject("publishConfig.access must be public");
}
NODE
}
