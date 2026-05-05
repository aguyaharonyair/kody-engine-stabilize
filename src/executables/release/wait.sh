#!/usr/bin/env bash
#
# release/wait.sh — wait_for_ci function: poll a PR's check rollup
# until all non-skipped checks pass, or timeout.
#
# Function: wait_for_ci <pr_number> <timeout_minutes>
# Exits 0 on CI_PASSED, exits 1 on CI_FAILED/CI_TIMEOUT.
#
# Reads gh pr checks <N> output. Treats SKIPPED as pass.

# shellcheck disable=SC2148

wait_for_ci() {
  local pr_number="$1"
  local timeout_minutes="${2:-60}"
  local poll_seconds="${3:-30}"
  local initial_wait="${4:-15}"

  if [[ -z "$pr_number" || ! "$pr_number" =~ ^[0-9]+$ ]]; then
    echo "[wait_for_ci] invalid pr_number: '$pr_number'" >&2
    return 1
  fi

  local deadline=$(( $(date +%s) + timeout_minutes * 60 ))
  echo "→ wait_for_ci: PR #${pr_number}, timeout=${timeout_minutes}m"

  # Initial wait — gives GHA time to register checks.
  sleep "$initial_wait"

  while (( $(date +%s) < deadline )); do
    # gh pr checks <N> --json prints an array of {state, name, ...}.
    local raw
    if ! raw=$(gh pr checks "$pr_number" --json state,name 2>/dev/null); then
      echo "  [wait_for_ci] gh pr checks failed; retrying in ${poll_seconds}s" >&2
      sleep "$poll_seconds"
      continue
    fi

    # Tally states. Anything that's still PENDING/IN_PROGRESS/QUEUED → keep waiting.
    # Anything FAILURE/CANCELLED/TIMED_OUT/ACTION_REQUIRED → fail fast.
    # SUCCESS/SKIPPED/NEUTRAL → pass.
    local summary
    summary=$(printf '%s' "$raw" | python3 -c '
import json, sys
data = json.load(sys.stdin)
buckets = {"pending": 0, "passed": 0, "failed": 0, "failed_names": []}
for r in data:
    s = (r.get("state") or "").upper()
    name = r.get("name") or "?"
    if s in ("PENDING", "IN_PROGRESS", "QUEUED", ""):
        buckets["pending"] += 1
    elif s in ("FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"):
        buckets["failed"] += 1
        buckets["failed_names"].append(name)
    else:  # SUCCESS, SKIPPED, NEUTRAL, etc.
        buckets["passed"] += 1
print(f"{buckets[\"pending\"]}|{buckets[\"passed\"]}|{buckets[\"failed\"]}|{','.join(buckets[\"failed_names\"][:5])}")
')

    local pending passed failed failed_names
    IFS='|' read -r pending passed failed failed_names <<< "$summary"

    echo "  [wait_for_ci] pending=${pending} passed=${passed} failed=${failed}"

    if [[ "$failed" -gt 0 ]]; then
      echo "[wait_for_ci] CI failed on PR #${pr_number}: ${failed_names}" >&2
      return 1
    fi
    if [[ "$pending" -eq 0 && "$passed" -gt 0 ]]; then
      echo "→ wait_for_ci: all checks passed (${passed}) on PR #${pr_number}"
      return 0
    fi

    sleep "$poll_seconds"
  done

  echo "[wait_for_ci] timeout after ${timeout_minutes}m on PR #${pr_number}" >&2
  return 1
}
