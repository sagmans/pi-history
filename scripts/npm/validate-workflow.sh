#!/usr/bin/env bash
# Validate the release workflow before any registry or repository mutation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=scripts/npm/lib.sh
source "${SCRIPT_DIR}/lib.sh"

readonly WORKFLOW_FILE="${WORKFLOW_FILE:-}"
readonly ENVIRONMENT="${ENVIRONMENT:-}"

validate_workflow_file "${WORKFLOW_FILE}"
validate_environment "${ENVIRONMENT}"
require_command "${NODE_BIN}"
require_workflow "${WORKFLOW_FILE}"

"${NODE_BIN}" --input-type=module - ".github/workflows/${WORKFLOW_FILE}" "${ENVIRONMENT}" <<'NODE'
import fs from "node:fs";

const workflowPath = process.argv[2];
const expectedEnvironment = process.argv[3];
const activeLines = fs
  .readFileSync(workflowPath, "utf8")
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
const hasLine = (expected) => activeLines.includes(expected);
const reject = (message) => {
  console.error(`error: workflow must ${message}`);
  process.exit(1);
};

if (!activeLines.some((line) => /^tags\s*:/u.test(line))) reject("declare a tag trigger");
if (!hasLine(`environment: ${expectedEnvironment}`)) reject("use the configured environment");
if (!hasLine("id-token: write")) reject("grant id-token: write");
const publishLine = activeLines.find((line) => /^-?\s*run:\s*npm publish(?:\s|$)/u.test(line));
if (!publishLine || !publishLine.includes("--provenance") || !publishLine.includes("--access public")) {
  reject("publish with provenance and public access");
}
NODE

printf 'workflow passed: %s\n' "${WORKFLOW_FILE}"
