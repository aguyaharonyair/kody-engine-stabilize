#!/usr/bin/env bash
#
# goal-tick: one deterministic tick for one goal. No agent. Pure scripts +
# `gh` against the connected repo.
#
# Inputs (env, set by the executor):
#   KODY_ARG_GOAL   the goal id (directory name under .kody/goals/)
#   KODY_CFG_GIT_DEFAULTBRANCH  the repo's default branch (usually main)
#
# What it does, per tick:
#   1. Read .kody/goals/<id>/state.json. If missing or state == "abandoned",
#      run cleanup (close goal PR, close open tasks) and set state=closed.
#   2. If state != "active", exit.
#   3. List issues with label `goal:<id>`.
#   4. If every such issue is closed → set state=done, open final goal-<id> →
#      default-branch PR (if not already open), commit + push state.json.
#   5. SERIALIZE: if any open issue still has the `goal-runner:dispatched`
#      label, stay idle. We dispatch the next task only after the previous
#      one has merged (issue closure follows PR merge via `Closes #N`).
#   6. If any issue carries `goal-runner:failed`, stay idle (a human must
#      unblock by removing the label or closing the issue).
#   7. Otherwise pick the lowest-numbered open issue without
#      `goal-runner:dispatched`. Comment `@kody --base goal-<id>` on it
#      and add the label so we don't re-dispatch on the next tick.
#   8. Bump updatedAt and commit state.json (cheap audit trail).
#
# Stdout signals:
#   KODY_SKIP_AGENT=true   — always; this is a no-agent flow.
#   KODY_REASON=<text>     — failure context (rare; gh errors etc).

set -euo pipefail

goal_id="${KODY_ARG_GOAL:-}"
default_branch="${KODY_CFG_GIT_DEFAULTBRANCH:-main}"

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
goal_branch="goal-${goal_id}"
label="goal:${goal_id}"
dispatched_label="goal-runner:dispatched"
failed_label="goal-runner:failed"

if [ ! -f "$state_file" ]; then
  echo "[goal-tick] no state file at $state_file — nothing to tick"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

# Read current state.
state=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('state',''))" "$state_file")

# ── Helpers ───────────────────────────────────────────────────────────────────

set_state_field() {
  # set_state_field <key> <value>  — value is treated as a JSON string.
  python3 - "$state_file" "$1" "$2" <<'PY'
import json, sys
from datetime import datetime, timezone
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    s = json.load(f)
s[key] = value
s["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
with open(path, "w") as f:
    json.dump(s, f, indent=2)
    f.write("\n")
PY
}

bump_updated_at() {
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
}

commit_state() {
  # commit_state <message>  — best-effort commit + push.
  git add "$state_file"
  if ! git diff --cached --quiet; then
    git commit -m "$1" --quiet
    git push --quiet || echo "[goal-tick] push failed (will retry next tick)"
  fi
}

ensure_label() {
  # ensure_label <name> <color> <description> — best-effort, never fails the tick.
  gh label create "$1" --color "$2" --description "$3" --force >/dev/null 2>&1 || true
}

list_goal_issues() {
  # Up to 100 goal-labelled issues. PRs filtered out.
  gh api \
    "repos/{owner}/{repo}/issues?labels=${label}&state=all&per_page=100" \
    --jq '[.[] | select(.pull_request == null) | {number, state: (.state | ascii_upcase), labels: [.labels[].name]}]'
}

# ── Cleanup path: state == abandoned ──────────────────────────────────────────

if [ "$state" = "abandoned" ]; then
  echo "[goal-tick] $goal_id is abandoned — running cleanup"

  # Close any open task issues with a brief note.
  issues_json=$(list_goal_issues)
  echo "$issues_json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for i in data:
    if i['state'] == 'OPEN':
        print(i['number'])
" | while read -r num; do
    [ -n "$num" ] || continue
    gh issue comment "$num" --body "_Goal abandoned — closing this task without dispatch._" >/dev/null 2>&1 || true
    gh issue close "$num" --reason "not planned" >/dev/null 2>&1 || true
  done

  # Close the goal PR if one is open.
  goal_pr=$(gh pr list --head "$goal_branch" --state open --json number --jq '.[0].number // empty' 2>/dev/null || echo "")
  if [ -n "$goal_pr" ]; then
    gh pr close "$goal_pr" --comment "_Goal abandoned by operator — closing without merge._" >/dev/null 2>&1 || true
  fi

  set_state_field "state" "closed"
  commit_state "chore(goals): abandon ${goal_id} (cleanup complete)"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

if [ "$state" != "active" ]; then
  echo "[goal-tick] $goal_id is '$state' — skipping"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

# ── Active path ───────────────────────────────────────────────────────────────

# Make sure the dedup labels exist before we read/write them.
ensure_label "$dispatched_label" "ededed" "kody goal-runner: already dispatched this tick"
ensure_label "$failed_label" "b60205" "kody goal-runner: task failed; needs human attention"

issues_json=$(list_goal_issues)
total=$(echo "$issues_json" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
if [ "$total" = "0" ]; then
  echo "[goal-tick] no issues with label '$label' — leaving state untouched"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

# Counts.
open_count=$(echo "$issues_json" | python3 -c "import json,sys; print(sum(1 for i in json.load(sys.stdin) if i['state']=='OPEN'))")

# All tasks closed → goal is done. Open the final goal-<id> → default-branch PR.
if [ "$open_count" = "0" ]; then
  echo "[goal-tick] all $total task(s) closed — finalising goal"

  # Open the goal PR if it doesn't already exist. We only care about origin/<goal_branch>:
  # the goal branch should exist (created by goal-scheduler). If not, log and skip
  # PR creation but still mark state=done so the goal moves out of `active`.
  goal_pr_url=""
  if git ls-remote --exit-code --heads origin "$goal_branch" >/dev/null 2>&1; then
    existing_pr=$(gh pr list --head "$goal_branch" --state open --json number,url --jq '.[0]' 2>/dev/null || echo "")
    if [ -z "$existing_pr" ] || [ "$existing_pr" = "null" ]; then
      title="goal: ${goal_id}"
      body=$(printf "Final integration PR for goal **%s**.\n\nAll task issues are closed and merged into \`%s\`. Ready for review.\n" "$goal_id" "$goal_branch")
      goal_pr_url=$(gh pr create \
        --head "$goal_branch" \
        --base "$default_branch" \
        --title "$title" \
        --body "$body" 2>/dev/null || echo "")
    else
      goal_pr_url=$(echo "$existing_pr" | python3 -c "import json,sys; print(json.load(sys.stdin).get('url',''))")
    fi
  else
    echo "[goal-tick] goal branch ${goal_branch} not found on origin — skipping final PR"
  fi

  python3 - "$state_file" "$goal_pr_url" <<'PY'
import json, sys
from datetime import datetime, timezone
path, pr_url = sys.argv[1], sys.argv[2]
with open(path) as f:
    s = json.load(f)
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
s["state"] = "done"
s["completedAt"] = now
s["updatedAt"] = now
if pr_url:
    s["goalPrUrl"] = pr_url
with open(path, "w") as f:
    json.dump(s, f, indent=2)
    f.write("\n")
PY
  commit_state "chore(goals): mark $goal_id done"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

# Failure gate: any task carrying the failed label means a human must intervene.
failed_count=$(echo "$issues_json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(sum(1 for i in data if 'goal-runner:failed' in i['labels']))
")
if [ "$failed_count" != "0" ]; then
  echo "[goal-tick] $failed_count failed task(s) — staying idle until cleared"
  bump_updated_at
  commit_state "chore(goals): tick $goal_id (blocked by failed task)"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

# Serialize: if any dispatched task is still open, wait. The previous task is
# still merging. We dispatch the next one only after closure (which happens on
# PR merge into the goal branch via `Closes #N`).
in_flight=$(echo "$issues_json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(sum(1 for i in data if i['state'] == 'OPEN' and 'goal-runner:dispatched' in i['labels']))
")
if [ "$in_flight" != "0" ]; then
  echo "[goal-tick] $in_flight task(s) in flight — waiting for current task to merge into ${goal_branch}"
  bump_updated_at
  commit_state "chore(goals): tick $goal_id (waiting for in-flight task)"
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
    and 'goal-runner:dispatched' not in i['labels']
]
opens.sort(key=lambda x: x['number'])
print(opens[0]['number'] if opens else '')
")

if [ -z "$next_issue" ]; then
  echo "[goal-tick] no undispatched open task — idle"
  bump_updated_at
  commit_state "chore(goals): tick $goal_id (idle)"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

echo "[goal-tick] dispatching @kody on task #$next_issue (--base $goal_branch)"
gh issue comment "$next_issue" --body "@kody --base ${goal_branch}"
gh issue edit "$next_issue" --add-label "$dispatched_label"

# Bump updatedAt + record last dispatched issue.
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
commit_state "chore(goals): dispatched #${next_issue} for ${goal_id}"

echo "KODY_SKIP_AGENT=true"
exit 0
