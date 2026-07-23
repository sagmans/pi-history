#!/usr/bin/env bash
# Verify public package metadata and the exact publish trust using read-only CLIs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=scripts/npm/lib.sh
source "${SCRIPT_DIR}/lib.sh"

readonly PKG_NAME="${PKG_NAME:-}"
readonly PKG_VERSION="${PKG_VERSION:-}"
readonly REPO="${REPO:-}"
readonly WORKFLOW_FILE="${WORKFLOW_FILE:-}"
readonly ENVIRONMENT="${ENVIRONMENT:-}"

validate_package_name "${PKG_NAME}"
validate_version "${PKG_VERSION}"
validate_repository "${REPO}"
validate_workflow_file "${WORKFLOW_FILE}"
validate_environment "${ENVIRONMENT}"
require_workflow "${WORKFLOW_FILE}"
require_command "${NPM_BIN}"
require_command "${NODE_BIN}"
require_npm_version

metadata_file="$(mktemp)"
access_file="$(mktemp)"
trust_file="$(mktemp)"
trap 'rm -f -- "${metadata_file}" "${access_file}" "${trust_file}"' EXIT

if "${NPM_BIN}" view "${PKG_NAME}@${PKG_VERSION}" name version repository dist --json >"${metadata_file}" 2>/dev/null; then
	:
else
	status=$?
	printf 'error: unable to read package metadata\n' >&2
	exit "${status}"
fi
if "${NPM_BIN}" access get status "${PKG_NAME}" --json >"${access_file}" 2>/dev/null; then
	:
else
	status=$?
	printf 'error: unable to read package access\n' >&2
	exit "${status}"
fi
if "${NPM_BIN}" trust list "${PKG_NAME}" --json >"${trust_file}" 2>/dev/null; then
	:
else
	status=$?
	printf 'error: unable to read trusted publishing\n' >&2
	exit "${status}"
fi

"${NODE_BIN}" --input-type=module - \
	"${metadata_file}" "${access_file}" "${trust_file}" \
	"${PKG_NAME}" "${PKG_VERSION}" "${REPO}" "${WORKFLOW_FILE}" "${ENVIRONMENT}" <<'NODE'
import fs from "node:fs";

const [metadataPath, accessPath, trustPath, packageName, packageVersion, repository, workflow, environment] = process.argv.slice(2);
const reject = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};
const readJson = (path, label) => {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    reject(`${label} returned invalid JSON`);
  }
};
const collectStrings = (value, output = []) => {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
};

const metadata = readJson(metadataPath, "package metadata");
const access = readJson(accessPath, "package access");
const trust = readJson(trustPath, "trusted publishing");
const repositoryUrl = typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url;
const acceptedRepositories = new Set([
  `git+https://github.com/${repository}.git`,
  `https://github.com/${repository}.git`,
  `https://github.com/${repository}`,
  `git@github.com:${repository}.git`,
]);

if (metadata.name !== packageName) reject("registry package name does not match PKG_NAME");
if (metadata.version !== packageVersion) reject("registry version does not match PKG_VERSION");
if (!acceptedRepositories.has(repositoryUrl)) reject("registry repository does not match REPO");
if (!metadata.dist?.integrity || !metadata.dist?.shasum) reject("registry dist integrity or shasum is missing");
if (!collectStrings(access).includes("public")) reject("package is not public");
const trustConfigs = Array.isArray(trust) ? trust : [trust];
const expectedTrust = trustConfigs.find(
  (config) =>
    config?.type === "github" &&
    config.file === workflow &&
    config.repository === repository &&
    config.environment === environment,
);
if (!expectedTrust) reject("GitHub trusted publisher identity does not match expected values");
if (
  !Array.isArray(expectedTrust.permissions) ||
  expectedTrust.permissions.length !== 1 ||
  expectedTrust.permissions[0] !== "createPackage"
) {
  reject("trusted publisher must have publish-only createPackage permission");
}
NODE

printf 'verification passed: %s@%s\n' "${PKG_NAME}" "${PKG_VERSION}"
