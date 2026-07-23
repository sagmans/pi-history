#!/usr/bin/env bash
# Stable entrypoint for the small npm setup helper modules.

NPM_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
readonly NPM_LIB_DIR
# shellcheck source=scripts/npm/lib/validation.sh
source "${NPM_LIB_DIR}/validation.sh"
# shellcheck source=scripts/npm/lib/execution.sh
source "${NPM_LIB_DIR}/execution.sh"
# shellcheck source=scripts/npm/lib/project.sh
source "${NPM_LIB_DIR}/project.sh"
