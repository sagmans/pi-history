#!/usr/bin/env bash
# Compatibility entrypoint; guarded implementation now lives with npm setup steps.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
exec bash "${SCRIPT_DIR}/../npm/setup-github-release.sh"
