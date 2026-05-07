#!/usr/bin/env bash
#
# goal-tick: one deterministic tick for one goal. No agent. Pure scripts +
# `gh` against the connected repo.
#
# Inputs (env, set by the executor):
#   KODY_ARG_GOAL   the goal id (directory name under .kody/goals/)
#
# What it does, per tick:
#   1. Read .kody/goals/<id>/state.json. If missing or state != "active", exit.
#   2. List issues with label `goal:<id>`.
#   3. If every such issue is closed → set state=done, completedAt=now,
#      commit + push state.json, exit.
#   4. Otherwise pick the lowest-numbered open issue without label
#      `goal-runner:dispatched`. Dispatch `@kody` on it (one new task per tick),
#      add the label so we don't re-dispatch on the next tick.
#   5. Bump updatedAt and commit state.json (cheap, but lets the engine
#      track per-tick activity in the repo history).
#
# Stdout signals:
#   KODY_SKIP_AGENT=true   — always; this is a no-agent flow.
#   KODY_REASON=<text>     — failure context (rare; gh errors etc).

set -euo pipefail

goal_id="${KODY_ARG_GOAL:-}"
if [ -z "$goal_id" ]; then
  echo "KODY_REASON=missing --goal"
  echo "KODY_SKIP_AGENT=true"
  exit 1
fi

# Defensive: refuse path traversal in goal id.
if [[ "$goal_id" == *"/"* || "$goal_id" == *".."* ]]; then
  echo "KODY_REASON=invalid goal id (no slashes or '..' allowed)"
  echo "KODY_SKIP_AGENT=true"
  exit 1
fi

state_dir=".kody/goals/${goal_id}"
state_file="${state_dir}/state.json"

if [ ! -f "$state_file" ]; then
  echo "[goal-tick] no state file at $state_file — nothing to tick"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

# Read current state. python3 is already required by other shell executables
# (e.g. release-prepare.sh), so we lean on it for JSON read/write.
state=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('state',''))" "$state_file")

if [ "$state" != "active" ]; then
  echo "[goal-tick] $goal_id is '$state' — skipping"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

label="goal:${goal_id}"
dispatched_label="goal-runner:dispatched"

# Fetch up to 100 goal-labelled issues. 100 is a soft ceiling — if a goal
# grows past that, we'll need pagination.
#
# Use `gh api` (not `gh issue list --label`) because the latter chokes on
# colons in label names, which is exactly the convention used here
# (`goal:<id>` etc). `gh api` also lets us filter PRs out cleanly via the
# `pull_request` field GitHub attaches to issue payloads.
issues_json=$(gh api \
  "repos/{owner}/{repo}/issues?labels=${label}&state=all&per_page=100" \
  --jq '[.[] | select(.pull_request == null) | {number, state: (.state | ascii_upcase), labels: .labels}]')

total=$(echo "$issues_json" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
if [ "$total" = "0" ]; then
  echo "[goal-tick] no issues with label '$label' — leaving state untouched"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

open_count=$(echo "$issues_json" | python3 -c "import json,sys; print(sum(1 for i in json.load(sys.stdin) if i['state']=='OPEN'))")

# All done? mark goal done and commit.
if [ "$open_count" = "0" ]; then
  echo "[goal-tick] all $total task(s) closed — marking goal done"
  python3 - "$state_file" <<'PY'
import json, sys
from datetime import datetime, timezone
path = sys.argv[1]
with open(path) as f:
    s = json.load(f)
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
s["state"] = "done"
s["completedAt"] = now
s["updatedAt"] = now
with open(path, "w") as f:
    json.dump(s, f, indent=2)
    f.write("\n")
PY
  git add "$state_file"
  if ! git diff --cached --quiet; then
    git commit -m "chore(goals): mark $goal_id done" --quiet
    git push --quiet || echo "[goal-tick] push failed (will retry next tick)"
  fi
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

# Pick the lowest-numbered open issue without the dispatched marker.
next_issue=$(echo "$issues_json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
opens = [
    i for i in data
    if i['state'] == 'OPEN'
    and 'goal-runner:dispatched' not in [l['name'] for l in i.get('labels', [])]
]
opens.sort(key=lambda x: x['number'])
print(opens[0]['number'] if opens else '')
")

if [ -z "$next_issue" ]; then
  echo "[goal-tick] all open tasks already dispatched — waiting for them to complete"
  # Bump updatedAt so the dashboard can show "last ticked at" without parsing logs.
  python3 - "$state_file" <<'PY'
import json, sys
from datetime import datetime, timezone
path = sys.argv[1]
with open(path) as f:
    s = json.load(f)
s["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
with open(path, "w") as f:
    json.dump(s, f, indent=2)
    f.write("\n")
PY
  git add "$state_file"
  if ! git diff --cached --quiet; then
    git commit -m "chore(goals): tick $goal_id (idle)" --quiet
    git push --quiet || echo "[goal-tick] push failed (will retry next tick)"
  fi
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

echo "[goal-tick] dispatching @kody on task #$next_issue"
gh issue comment "$next_issue" --body "@kody"
gh issue edit "$next_issue" --add-label "$dispatched_label" || true

# Bump updatedAt so the file changes (cheap audit trail in git log).
python3 - "$state_file" "$next_issue" <<'PY'
import json, sys
from datetime import datetime, timezone
path = sys.argv[1]
issue = int(sys.argv[2])
with open(path) as f:
    s = json.load(f)
s["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
s["lastDispatchedIssue"] = issue
with open(path, "w") as f:
    json.dump(s, f, indent=2)
    f.write("\n")
PY
git add "$state_file"
if ! git diff --cached --quiet; then
  git commit -m "chore(goals): dispatched #${next_issue} for ${goal_id}" --quiet
  git push --quiet || echo "[goal-tick] push failed (will retry next tick)"
fi

echo "KODY_SKIP_AGENT=true"
exit 0
