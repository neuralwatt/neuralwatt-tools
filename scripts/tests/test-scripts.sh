#!/bin/bash
# Tests for nw-usage and install-nw-usage. Runs offline: a fake curl on PATH
# returns fixture responses, and HOME and the cache file point at a temp dir.
#
# Usage: scripts/tests/test-scripts.sh
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'CURL'
#!/bin/bash
cat "$NW_TEST_FIXTURE"
CURL
chmod +x "$TMP/bin/curl"

export PATH="$TMP/bin:$PATH"
export NEURALWATT_API_KEY="test-key"
export NW_USAGE_CACHE_FILE="$TMP/nw-usage-cache.json"

today=$(jq -nr 'now | strftime("%Y-%m-%d")')
yesterday=$(jq -nr 'now - 86400 | strftime("%Y-%m-%d")')
failures=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    failures=$((failures + 1))
  fi
}

run_nw_usage() {
  local fixture="$1"
  shift
  rm -f "$NW_USAGE_CACHE_FILE"
  printf '%s\n' "$fixture" > "$TMP/fixture.json"
  NW_TEST_FIXTURE="$TMP/fixture.json" "$SCRIPTS_DIR/nw-usage" "$@" 2>&1 || echo "exit=$?"
}

day() {
  printf '{"date":"%s","requests":%s,"energy_kwh":%s,"energy_joules":%s}' "$1" "$2" "$3" "$4"
}

# nw-usage: today's row is picked by date, not position.
fixture="{\"daily\":[$(day "$today" 42 0.156 561600),$(day "$yesterday" 7 0.5 1800000)]}"
check "today row (tmux)" "↗42 ⚡156Wh" "$(run_nw_usage "$fixture" --tmux)"
check "today row (human)" "Neuralwatt Usage for $today
  Requests: 42
  Energy: 156Wh (561600J)" "$(run_nw_usage "$fixture")"

# nw-usage: before the first request of the day, only yesterday has a row.
fixture="{\"daily\":[$(day "$yesterday" 7 0.5 1800000)]}"
check "only yesterday (tmux)" "↗0 ⚡0Wh" "$(run_nw_usage "$fixture" --tmux)"
check "only yesterday (human)" "Neuralwatt Usage for $today
  Requests: 0
  Energy: 0Wh (0J)" "$(run_nw_usage "$fixture")"

# nw-usage: an account with no usage in the window.
check "empty daily (tmux)" "↗0 ⚡0Wh" "$(run_nw_usage '{"daily":[]}' --tmux)"

# nw-usage: API errors still fail.
check "API error" "Error: Failed to fetch usage data
exit=1" "$(run_nw_usage '{"detail":"Invalid API key"}' --tmux)"
check "empty response" "Error: Failed to fetch usage data
exit=1" "$(run_nw_usage '' --tmux)"

# install-nw-usage --global: the OpenCode template must hold real newlines and
# the file must stay valid JSON, including when echo interprets escapes.
# Backticks are literal in the template.
# shellcheck disable=SC2016
expected_template='Here is my Neuralwatt API usage:

!`nw-usage`

Report this to the user.'
for shell_opts in "" "-O xpg_echo"; do
  for existing in "" '{"model":"neuralwatt/nw-flash"}'; do
    home="$TMP/home-$RANDOM"
    mkdir -p "$home/.config/opencode"
    config="$home/.config/opencode/opencode.json"
    [[ -n "$existing" ]] && printf '%s\n' "$existing" > "$config"
    # shellcheck disable=SC2086
    HOME="$home" bash $shell_opts "$SCRIPTS_DIR/install-nw-usage" --global >/dev/null 2>&1 </dev/null || true
    kind=new
    [[ -n "$existing" ]] && kind=existing
    label="install --global (bash ${shell_opts:-default}, $kind config)"
    check "$label template" "$expected_template" \
      "$(jq -r '.command["nw-usage"].template' "$config" 2>&1)"
    if [[ -n "$existing" ]]; then
      check "$label keeps model" "neuralwatt/nw-flash" "$(jq -r '.model' "$config" 2>&1)"
    fi
  done
done

if [[ $failures -gt 0 ]]; then
  echo "$failures test(s) failed"
  exit 1
fi
echo "all tests passed"
