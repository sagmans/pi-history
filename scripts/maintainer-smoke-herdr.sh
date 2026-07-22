#!/usr/bin/env bash
set -euo pipefail

readonly TESTED_HERDR_VERSION="0.7.4"
readonly READY_TIMEOUT_MS="30000"
readonly STATUS_TIMEOUT_MS="30000"
readonly PANE_RATIO="0.5"
readonly CAPTURE_LINES="200"
readonly PRIVATE_DIR_MODE="700"
readonly PRIVATE_FILE_MODE="600"
readonly DIAGNOSTICS_VERSION="2"
readonly HISTORY_SCHEMA_VERSION="1"
readonly SMOKE_MAX_ENTRIES="42"
readonly SMOKE_ENTRY_COUNT="1"
readonly SMOKE_USE_COUNT="1"
readonly GLOBAL_SCOPE_KEY="<global>"
readonly SMOKE_CANARY="PI_HISTORY_SMOKE_SECRET_7E4A9C2D"
readonly FIXTURE_TIMESTAMP="2026-01-01T00:00:00.000Z"
readonly EXPECTED_DIAGNOSTIC="pi-history: diagnosticsVersion=$DIAGNOSTICS_VERSION; state=healthy; initialization=ready; storage=ready; editor=ready; entries=$SMOKE_ENTRY_COUNT; cap=$SMOKE_MAX_ENTRIES; scope=global"

smoke_root=""
pane_id=""

cleanup() {
	local exit_code=$?
	trap - EXIT INT TERM
	if [[ -n "$pane_id" ]]; then
		herdr pane run "$pane_id" "/exit" >/dev/null 2>&1 || true
		herdr pane close "$pane_id" >/dev/null 2>&1 || true
	fi
	if [[ -n "$smoke_root" && -d "$smoke_root" ]]; then
		rm -rf -- "$smoke_root"
	fi
	exit "$exit_code"
}
trap cleanup EXIT INT TERM

fail() {
	printf 'pi-history Herdr smoke failed: %s\n' "$1" >&2
	exit 1
}

require_command_surface() {
	local pane_help wait_help
	pane_help="$(herdr pane 2>&1 || true)"
	wait_help="$(herdr wait 2>&1 || true)"
	for command in "pane split" "pane run" "pane read" "pane close"; do
		[[ "$pane_help" == *"$command"* ]] || fail "Herdr lacks required '$command' command"
	done
	[[ "$wait_help" == *"wait output"* ]] || fail "Herdr lacks required 'wait output' command"
}

parse_pane_id() {
	node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const id = JSON.parse(input)?.result?.pane?.pane_id;
  if (typeof id !== "string" || id.length === 0) process.exit(1);
  process.stdout.write(id);
});
'
}

extract_diagnostic() {
	node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let values = [input];
  try {
    const visit = (value) => {
      if (typeof value === "string") values.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(JSON.parse(input));
  } catch {}
  const prefix = "pi-history: diagnosticsVersion=";
  const matches = values.flatMap((value) => {
    const start = value.lastIndexOf(prefix);
    if (start < 0) return [];
    const segment = value.slice(start).match(/^pi-history: diagnosticsVersion=[\s\S]*?scope=[a-z_]+/);
    return segment ? [segment[0].replace(/\s+/g, " ").trim()] : [];
  });
  if (matches.length === 0) process.exit(1);
  process.stdout.write(matches.at(-1));
});
'
}

[[ "${HERDR_ENV:-}" == "1" ]] || fail "HERDR_ENV=1 is required"
command -v herdr >/dev/null 2>&1 || fail "herdr is not available"
command -v node >/dev/null 2>&1 || fail "node is not available"
pi_bin="$(command -v pi || true)"
[[ -n "$pi_bin" ]] || fail "pi is not available"
require_command_surface
herdr pane current --current >/dev/null || fail "current Herdr pane is unavailable"
herdr_version="$(herdr --version)"
printf 'pi-history Herdr smoke: %s (command surface tested with %s)\n' "$herdr_version" "$TESTED_HERDR_VERSION"

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/pi-history-herdr-smoke.XXXXXX")"
smoke_home="$smoke_root/home"
agent_dir="$smoke_root/agent"
history_dir="$smoke_home/.pi/agent/pi-history"
umask 077
mkdir -p -- "$history_dir" "$agent_dir"
chmod "$PRIVATE_DIR_MODE" "$smoke_home" "$agent_dir" "$history_dir"

cat >"$history_dir/config.json" <<JSON
{
  "maxEntries": $SMOKE_MAX_ENTRIES,
  "isolationLevel": "global"
}
JSON
cat >"$history_dir/global.json" <<JSON
{
  "schemaVersion": $HISTORY_SCHEMA_VERSION,
  "projectRoot": "$GLOBAL_SCOPE_KEY",
  "createdAt": "$FIXTURE_TIMESTAMP",
  "updatedAt": "$FIXTURE_TIMESTAMP",
  "entries": [
    {
      "text": "$SMOKE_CANARY",
      "createdAt": "$FIXTURE_TIMESTAMP",
      "updatedAt": "$FIXTURE_TIMESTAMP",
      "useCount": $SMOKE_USE_COUNT
    }
  ]
}
JSON
chmod "$PRIVATE_FILE_MODE" "$history_dir/config.json" "$history_dir/global.json"

split_json="$(
	herdr pane split --current --direction right --ratio "$PANE_RATIO" --cwd "$repo_root" \
		--env "HOME=$smoke_home" \
		--env "PI_CODING_AGENT_DIR=$agent_dir" \
		--env "PI_SKIP_VERSION_CHECK=1" \
		--env "PI_TELEMETRY=0" \
		--no-focus
)"
pane_id="$(printf '%s' "$split_json" | parse_pane_id)" || fail "unable to parse created pane ID"
[[ -n "$pane_id" ]] || fail "Herdr did not return a pane ID"
herdr wait output "$pane_id" --match "$(basename -- "$repo_root")" --source recent-unwrapped \
	--timeout "$READY_TIMEOUT_MS" >/dev/null || fail "created shell did not become ready"

pi_version="$($pi_bin --version)"
printf -v launch_command 'exec env HOME=%q PI_CODING_AGENT_DIR=%q PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 %q --approve --no-session -e .' \
	"$smoke_home" "$agent_dir" "$pi_bin"
herdr pane run "$pane_id" "$launch_command" >/dev/null
herdr wait output "$pane_id" --match "pi v$pi_version" --source recent-unwrapped \
	--timeout "$READY_TIMEOUT_MS" >/dev/null || fail "Pi TUI did not become ready"

herdr pane run "$pane_id" "/pi-history status" >/dev/null
herdr wait output "$pane_id" --match "pi-history: diagnosticsVersion=$DIAGNOSTICS_VERSION;" --source recent-unwrapped \
	--timeout "$STATUS_TIMEOUT_MS" >/dev/null || fail "versioned diagnostic did not appear"
pane_json="$(herdr pane read "$pane_id" --source recent-unwrapped --lines "$CAPTURE_LINES" --format text)"
diagnostic="$(printf '%s' "$pane_json" | extract_diagnostic)" || fail "unable to extract diagnostic line"

[[ "$diagnostic" == "$EXPECTED_DIAGNOSTIC" ]] || fail "diagnostic contract mismatch"
for private_value in "$SMOKE_CANARY" "$repo_root" "$history_dir" "$smoke_root" "$smoke_home" "$agent_dir"; do
	[[ "$diagnostic" != *"$private_value"* ]] || fail "diagnostic exposed private runtime data"
done

printf 'pi-history Herdr smoke passed: %s\n' "$diagnostic"
