#!/usr/bin/env bash
#
# release/wait.sh — wait_for_ci function: poll a PR's check rollup
# until all non-skipped checks pass, or timeout.
#
# Function: wait_for_ci <pr_number> <timeout_minutes> [poll_seconds] [initial_wait]
# Returns 0 on CI passed, 1 on CI failed/timeout.
#
# Special-case: if a PR has zero registered checks (no CI configured),
# treats that as PASSED after a short stabilization window — so a Tester
# repo without checks doesn't loop forever.

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

  sleep "$initial_wait"

  # Track consecutive "no checks" results so we don't bail prematurely
  # on a PR that's just slow to register checks.
  local empty_count=0
  local empty_threshold=4   # ~2 minutes (4 * poll_seconds=30s) before treating as no-CI

  while (( $(date +%s) < deadline )); do
    local raw
    if ! raw=$(gh pr checks "$pr_number" --json state 2>/dev/null); then
      # gh exits non-zero when there are no checks — treat as no-CI.
      empty_count=$((empty_count + 1))
      echo "  [wait_for_ci] gh pr checks returned non-zero (count=${empty_count})"
      if (( empty_count >= empty_threshold )); then
        echo "→ wait_for_ci: PR #${pr_number} has no CI checks configured — treating as passed"
        return 0
      fi
      sleep "$poll_seconds"
      continue
    fi

    # Empty array? Same path.
    local total
    total=$(printf '%s' "$raw" | jq 'length' 2>/dev/null || echo "0")
    if [[ "$total" == "0" ]]; then
      empty_count=$((empty_count + 1))
      echo "  [wait_for_ci] no checks registered yet (count=${empty_count})"
      if (( empty_count >= empty_threshold )); then
        echo "→ wait_for_ci: PR #${pr_number} has no CI checks configured — treating as passed"
        return 0
      fi
      sleep "$poll_seconds"
      continue
    fi
    empty_count=0

    # Tally states via jq.
    local pending failed passed failed_names
    pending=$(printf '%s' "$raw" | jq '[.[] | select((.state // "") | IN("PENDING","IN_PROGRESS","QUEUED",""))] | length')
    failed=$(printf '%s' "$raw" | jq '[.[] | select((.state // "") | IN("FAILURE","CANCELLED","TIMED_OUT","ACTION_REQUIRED","STARTUP_FAILURE"))] | length')
    passed=$(printf '%s' "$raw" | jq '[.[] | select((.state // "") | IN("SUCCESS","SKIPPED","NEUTRAL"))] | length')
    failed_names=$(printf '%s' "$raw" | jq -r '[.[] | select((.state // "") | IN("FAILURE","CANCELLED","TIMED_OUT","ACTION_REQUIRED","STARTUP_FAILURE")) | .name] | join(",")')

    echo "  [wait_for_ci] pending=${pending} passed=${passed} failed=${failed} (total=${total})"

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
