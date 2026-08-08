#!/usr/bin/env bash
set -euo pipefail

readonly TESTED_HERDR_VERSION="0.8.0"
readonly READY_TIMEOUT_MS="30000"
readonly STATUS_TIMEOUT_MS="30000"
readonly PANE_RATIO="0.5"
readonly CAPTURE_LINES="200"
readonly PRIVATE_DIR_MODE="700"
readonly PRIVATE_FILE_MODE="600"
# Must match src/diagnostics.ts DIAGNOSTICS_VERSION and src/history-store.ts
# HISTORY_SCHEMA_VERSION; the hardcoded values double as a cross-check against
# the real extension output below, so a bump that forgets this script fails the
# smoke rather than passing silently. The legacy fixture pins the oldest
# supported input schema on purpose: it proves migration, not the native write
# path.
readonly DIAGNOSTICS_VERSION="2"
readonly HISTORY_SCHEMA_VERSION="3"
readonly LEGACY_HISTORY_SCHEMA_VERSION="1"
readonly SMOKE_MAX_ENTRIES="42"
readonly LEGACY_SMOKE_MAX_ENTRIES="99"
readonly SMOKE_ENTRIES_SEEDED="1"
readonly SMOKE_ENTRIES_AFTER_CAPTURE="2"
readonly SMOKE_ENTRIES_AFTER_CLEAR="0"
readonly SMOKE_USE_COUNT="1"
readonly GLOBAL_SCOPE_KEY="<global>"
readonly SMOKE_CANARY="PI_HISTORY_SMOKE_SECRET_7E4A9C2D"
readonly LEGACY_SMOKE_CANARY="PI_HISTORY_LEGACY_SECRET_8F5B0D3E"
readonly CAPTURE_CANARY="PI_HISTORY_SMOKE_CAPTURE_1A2B3C4D"
readonly STATUS_MARKER_PREFIX="PI_HISTORY_SMOKE_STATUS_"
readonly AGENT_NAME="pi-history-smoke"
readonly FIXTURE_TIMESTAMP="2026-01-01T00:00:00.000Z"
readonly CAPTURE_POLL_TIMEOUT_S="10"
readonly RESTART_BOOT_DELAY_S="3"

smoke_root=""
pane_id=""
agent=""
status_sequence=0

cleanup() {
	local exit_code=$?
	trap - EXIT INT TERM
	if [[ -n "$agent" ]]; then
		herdr agent prompt "$agent" "/quit" >/dev/null 2>&1 || true
	fi
	if [[ -n "$pane_id" ]]; then
		# Herdr 0.8.0 has no pane close command; terminating the disposable
		# shell is what closes the created pane. Only the smoke pane's own
		# shell PID is targeted.
		local shell_pid
		shell_pid="$(
			herdr pane process-info --pane "$pane_id" 2>/dev/null |
				node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const pid = JSON.parse(input)?.result?.process_info?.shell_pid;
  if (typeof pid === "number" && pid > 0) process.stdout.write(String(pid));
});
' 2>/dev/null || true
		)"
		if [[ -n "$shell_pid" ]]; then
			kill "$shell_pid" >/dev/null 2>&1 || true
			sleep 1
			if kill -0 "$shell_pid" >/dev/null 2>&1; then
				kill -9 "$shell_pid" >/dev/null 2>&1 || true
			fi
		fi
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
	local pane_help agent_help
	pane_help="$(herdr pane 2>&1 || true)"
	agent_help="$(herdr agent 2>&1 || true)"
	for command in "split" "read" "process-info"; do
		[[ "$pane_help" == *"$command"* ]] || fail "Herdr lacks required 'pane $command' command"
	done
	for command in "start" "prompt" "read" "send-keys" "wait"; do
		[[ "$agent_help" == *"$command"* ]] || fail "Herdr lacks required 'agent $command' command"
	done
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

parse_agent_name() {
	node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const name = JSON.parse(input)?.result?.agent?.name;
  if (typeof name !== "string" || name.length === 0) process.exit(1);
  process.stdout.write(name);
});
'
}

shell_is_foreground() {
	herdr pane process-info --pane "$pane_id" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const info = JSON.parse(input)?.result?.process_info;
  const processes = info?.foreground_processes;
  if (!info || !Array.isArray(processes)) process.exit(1);
  if (processes.length === 0 || processes.every((process) => process.pid === info.shell_pid)) return;
  process.exit(1);
});
'
}

wait_for_shell() {
	local deadline=$((SECONDS + READY_TIMEOUT_MS / 1000))
	for ((;;)); do
		shell_is_foreground && return 0
		((SECONDS < deadline)) || return 1
		sleep 0.2
	done
}

read_pane() {
	herdr pane read "$pane_id" --source recent-unwrapped --lines "$CAPTURE_LINES" --format text
}

# Herdr 0.8.0 removed 'wait output'; polling the unwrapped snapshot is the
# equivalent over the remaining read surface.
wait_for_output() {
	local match="$1" deadline=$((SECONDS + READY_TIMEOUT_MS / 1000))
	for ((;;)); do
		read_pane 2>/dev/null | grep -qF "$match" && return 0
		((SECONDS < deadline)) || return 1
		sleep 0.2
	done
}

# agent start requires the pane's interactive shell prompt, which may lag the
# split itself; retry within the readiness budget instead of racing it.
start_agent() {
	local name="$1" deadline=$((SECONDS + READY_TIMEOUT_MS / 1000)) start_json
	for ((;;)); do
		if start_json="$(
			herdr agent start "$name" --kind pi --pane "$pane_id" \
				--timeout "$READY_TIMEOUT_MS" -- --approve --no-session -e . 2>/dev/null
		)"; then
			printf '%s' "$start_json" | parse_agent_name
			return 0
		fi
		((SECONDS < deadline)) || return 1
		sleep 0.5
	done
}

extract_diagnostic() {
	node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const expected = process.argv[1];
  const marker = process.argv[2];
  const escapeChar = (char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (marker) {
    const escapedMarker = [...marker].map(escapeChar).join("\\s*");
    const markerPattern = new RegExp(`Session\\s*name\\s*set:\\s*${escapedMarker}`, "g");
    const matches = [...input.matchAll(markerPattern)];
    const match = matches.at(-1);
    if (!match) process.exit(1);
    input = input.slice(match.index + match[0].length);
  }
  const compactExpected = expected.replace(/\s+/g, "");
  const escapedExpected = [...compactExpected].map(escapeChar).join("\\s*");
  const pattern = new RegExp(`${escapedExpected}(?=[ \\t]*(?:\\r?\\n|$))`, "g");
  // Rendered soft wraps add whitespace; source-level tests pin exact spacing.
  if (![...input.matchAll(pattern)].at(-1)) process.exit(1);
  process.stdout.write(expected);
});
' "$1" "${2:-}"
}

expected_diagnostic() {
	printf 'pi-history: diagnosticsVersion=%s; state=healthy; initialization=ready; storage=ready; editor=ready; entries=%s; cap=%s; scope=global' \
		"$DIAGNOSTICS_VERSION" "$1" "$SMOKE_MAX_ENTRIES"
}

wait_for_diagnostic() {
	local expected="$1" marker="$2" deadline=$((SECONDS + STATUS_TIMEOUT_MS / 1000))
	local pane_text diagnostic
	for ((;;)); do
		pane_text="$(read_pane)" || return 1
		if diagnostic="$(printf '%s' "$pane_text" | extract_diagnostic "$expected" "$marker")"; then
			printf '%s' "$diagnostic"
			return 0
		fi
		((SECONDS < deadline)) || return 1
		sleep 0.2
	done
}

run_status_check() {
	local expected_entries="$1" expected marker diagnostic
	expected="$(expected_diagnostic "$expected_entries")"
	((status_sequence += 1))
	marker="${STATUS_MARKER_PREFIX}${status_sequence}"
	herdr agent prompt "$agent" "/name $marker" >/dev/null
	wait_for_output "$marker" || fail "status freshness marker did not appear"
	# The TUI still settles the rename after the marker renders; prompting the
	# status command immediately can interleave with that handling.
	sleep 1
	herdr agent prompt "$agent" "/pi-history status" >/dev/null
	diagnostic="$(wait_for_diagnostic "$expected" "$marker")" ||
		fail "expected diagnostic for entries=$expected_entries did not appear"
	[[ "$diagnostic" == "$expected" ]] || fail "diagnostic contract mismatch"
	local private_value
	for private_value in "$SMOKE_CANARY" "$LEGACY_SMOKE_CANARY" "$CAPTURE_CANARY" \
		"$repo_root" "$history_dir" "$legacy_history_dir" "$smoke_root" "$smoke_home" "$agent_dir"; do
		[[ "$diagnostic" != *"$private_value"* ]] || fail "diagnostic exposed private runtime data"
	done
	last_diagnostic="$diagnostic"
}

count_file_entries() {
	node -e '
const fs = require("node:fs");
try {
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(Array.isArray(data.entries) ? data.entries.length : -1));
} catch {
  process.stdout.write("-1");
}
' "$history_dir/global.json"
}

wait_for_file_entries() {
	local expected_count="$1"
	local deadline=$((SECONDS + CAPTURE_POLL_TIMEOUT_S))
	for ((;;)); do
		[[ "$(count_file_entries)" == "$expected_count" ]] && return 0
		((SECONDS < deadline)) || return 1
		sleep 0.2
	done
}

# On-disk contract check: fails whenever the native schema version or the
# required clear-lineage fields drift from the runtime that wrote the file.
check_history_file() {
	local epoch_mode="$1" expected_count="$2"
	node - "$history_dir/global.json" "$HISTORY_SCHEMA_VERSION" "$epoch_mode" "$expected_count" <<'NODE'
const fs = require("node:fs");
const [file, schemaVersion, epochMode, expectedCount] = process.argv.slice(2);
const fail = (message) => {
  console.error(`native history contract drift: ${message}`);
  process.exit(1);
};
const data = JSON.parse(fs.readFileSync(file, "utf8"));
if (data.schemaVersion !== Number(schemaVersion)) fail("schemaVersion drift");
if (!Array.isArray(data.entries) || data.entries.length !== Number(expectedCount)) fail("entries drift");
if (epochMode === "null" && data.clearEpoch !== null) fail("clearEpoch must be null before any clear");
if (epochMode === "minted" && (typeof data.clearEpoch !== "string" || data.clearEpoch.length === 0)) {
  fail("clearEpoch must be an opaque string after a confirmed clear");
}
if (epochMode === "minted" && typeof data.clearedAt !== "string") fail("clearedAt marker missing");
NODE
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
history_dir="$agent_dir/pi-history"
legacy_history_dir="$smoke_home/.pi/agent/pi-history"
umask 077
mkdir -p -- "$history_dir" "$legacy_history_dir"
chmod "$PRIVATE_DIR_MODE" "$smoke_home" "$agent_dir" "$history_dir" "$legacy_history_dir"

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
  "clearEpoch": null,
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

cat >"$legacy_history_dir/config.json" <<JSON
{
  "maxEntries": $LEGACY_SMOKE_MAX_ENTRIES,
  "isolationLevel": "global"
}
JSON
cat >"$legacy_history_dir/global.json" <<JSON
{
  "schemaVersion": $LEGACY_HISTORY_SCHEMA_VERSION,
  "projectRoot": "$GLOBAL_SCOPE_KEY",
  "createdAt": "$FIXTURE_TIMESTAMP",
  "updatedAt": "$FIXTURE_TIMESTAMP",
  "entries": [
    {
      "text": "$LEGACY_SMOKE_CANARY",
      "createdAt": "$FIXTURE_TIMESTAMP",
      "updatedAt": "$FIXTURE_TIMESTAMP",
      "useCount": $SMOKE_USE_COUNT
    }
  ]
}
JSON
chmod "$PRIVATE_FILE_MODE" "$legacy_history_dir/config.json" "$legacy_history_dir/global.json"

split_json="$(
	herdr pane split --current --direction right --ratio "$PANE_RATIO" --cwd "$repo_root" \
		--env "HOME=$smoke_home" \
		--env "PI_CODING_AGENT_DIR=$agent_dir" \
		--env "PI_SKIP_VERSION_CHECK=1" \
		--env "PI_TELEMETRY=0"
)"
pane_id="$(printf '%s' "$split_json" | parse_pane_id)" || fail "unable to parse created pane ID"
[[ -n "$pane_id" ]] || fail "Herdr did not return a pane ID"

pi_version="$($pi_bin --version)"
agent="$(start_agent "$AGENT_NAME")" || fail "Pi TUI did not become ready"
# agent start already proved interactive readiness; the banner match pins the
# exact launched version on top.
wait_for_output "pi v$pi_version" || fail "Pi version banner did not appear"
last_diagnostic=""
run_status_check "$SMOKE_ENTRIES_SEEDED"

# One synthetic capture: the extension records at submit time, so the agent
# turn may fail without provider credentials without affecting this proof.
herdr agent prompt "$agent" "$CAPTURE_CANARY" >/dev/null
wait_for_file_entries "$SMOKE_ENTRIES_AFTER_CAPTURE" || fail "synthetic capture was not persisted"
herdr agent send-keys "$agent" esc >/dev/null
herdr agent wait "$agent" --until idle --timeout "$STATUS_TIMEOUT_MS" >/dev/null ||
	fail "Pi TUI did not return to command mode"
run_status_check "$SMOKE_ENTRIES_AFTER_CAPTURE"
check_history_file null "$SMOKE_ENTRIES_AFTER_CAPTURE" || fail "native contract drift after capture"

# Confirmed clear: the dialog is a selector with "Yes" preselected, so a
# matching selection plus Enter confirms it.
herdr agent prompt "$agent" "/pi-history clear" >/dev/null
wait_for_output "Clear pi-history?" || fail "clear confirmation did not appear"
herdr agent prompt "$agent" "Yes" >/dev/null
wait_for_output "pi-history cleared" || fail "confirmed clear did not complete"
run_status_check "$SMOKE_ENTRIES_AFTER_CLEAR"
check_history_file minted "$SMOKE_ENTRIES_AFTER_CLEAR" || fail "native contract drift after clear"

# Restart persistence: a fresh TUI must load the cleared native state. The
# restart gets a distinct agent name because the first agent record may
# outlive its pi process.
herdr agent prompt "$agent" "/quit" >/dev/null
wait_for_shell || fail "Pi TUI did not exit before restart"
agent="$(start_agent "${AGENT_NAME}-restart")" || fail "Pi TUI did not restart"
sleep "$RESTART_BOOT_DELAY_S"
run_status_check "$SMOKE_ENTRIES_AFTER_CLEAR"

printf 'pi-history Herdr smoke passed: %s\n' "$last_diagnostic"
