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

read_state_field() {
  # read_state_field <key>  — prints the value or empty string. Never fails.
  python3 - "$state_file" "$1" <<'PY' 2>/dev/null || echo ""
import json, sys
path, key = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        s = json.load(f)
    v = s.get(key, "")
    print("" if v is None else v)
except Exception:
    print("")
PY
}

ensure_goal_issue() {
  # Create-or-adopt the umbrella goal issue (once), label it goal:<id> +
  # kody:building, and persist its number on state.json. The issue auto-closes
  # when the final goal PR merges, via the `Closes #N` line we add to that PR
  # body.
  #
  # Lookup order:
  #   1. state.json `goalIssueNumber` — fast path.
  #   2. Search GitHub for an existing umbrella by label `goal:<id>` + the
  #      canonical title `goal: <goal_id>`. This is the recovery path when
  #      state.json got wiped (e.g. dashboard pause/resume dropped the field
  #      in older versions). Without this lookup we'd open a duplicate
  #      umbrella every time goalIssueNumber goes missing.
  #   3. Create a fresh umbrella as a last resort.
  local existing
  existing=$(read_state_field "goalIssueNumber")
  if [ -n "$existing" ] && [ "$existing" != "0" ]; then
    return 0
  fi

  ensure_label "$label" "0e8a16" "kody goal task: belongs to goal ${goal_id}"
  ensure_label "kody:building" "1d76db" "kody: in-flight (work being assembled on a branch)"

  local title body num
  title="goal: ${goal_id}"
  body=$(printf "Umbrella issue for goal **%s**.\n\nClosed automatically when the goal PR (\`%s\` → \`%s\`) merges.\n" \
    "$goal_id" "$goal_branch" "$default_branch")

  # Recovery path: an umbrella may already exist from a prior run that lost
  # state. Match strictly by label + exact title to avoid grabbing a child
  # task issue. Prefer OPEN issues; fall back to closed ones (the umbrella
  # could have been closed by a prior goal PR merge that we're now re-driving).
  num=$(gh api \
    "repos/{owner}/{repo}/issues?labels=${label}&state=all&per_page=100" \
    --jq "[.[] | select(.pull_request == null) | select(.title == \"${title}\")] | (map(select(.state == \"open\")) + map(select(.state != \"open\")))[0].number // empty" \
    2>/dev/null || echo "")

  if [ -n "$num" ] && [[ "$num" =~ ^[0-9]+$ ]]; then
    echo "[goal-tick] adopted existing umbrella issue #${num} for ${goal_id}"
  else
    # `gh issue create` prints the new issue's URL on stdout
    # (https://github.com/<owner>/<repo>/issues/<n>). It does NOT support
    # --json/--jq, so parse the trailing number off the URL.
    local url
    url=$(gh issue create \
      --title "$title" \
      --body "$body" \
      --label "$label" \
      --label "kody:building" 2>/dev/null || echo "")

    num="${url##*/}"
    if [ -z "$num" ] || ! [[ "$num" =~ ^[0-9]+$ ]]; then
      echo "[goal-tick] ensure_goal_issue: gh issue create failed (got '${url}') — continuing without umbrella issue"
      return 0
    fi
    echo "[goal-tick] opened umbrella issue #${num} for ${goal_id}"
  fi

  python3 - "$state_file" "$num" <<'PY'
import json, sys
from datetime import datetime, timezone
path = sys.argv[1]
n = int(sys.argv[2])
with open(path) as f:
    s = json.load(f)
s["goalIssueNumber"] = n
s["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
with open(path, "w") as f:
    json.dump(s, f, indent=2)
    f.write("\n")
PY
}

ensure_goal_pr() {
  # Open a draft goal PR (`goal-<id>` → default branch) early in the goal's
  # life so the dashboard has a single anchor that ties together the umbrella
  # issue, the goal branch, and the Vercel preview deploy. Without this PR,
  # the umbrella issue is just a label-tagged issue with no link to its
  # branch, so the dashboard can't surface preview/CI/branch on the umbrella
  # row.
  #
  # Lifecycle:
  #   - Created here as DRAFT on every active tick once origin/<goal_branch>
  #     exists. Body carries `Closes #<umbrellaNumber>` so the umbrella
  #     auto-closes on merge.
  #   - Promoted to ready-for-review by the finalize path when all child
  #     tasks close (see below).
  #
  # Lookup order:
  #   1. state.json `goalPrUrl` — fast path; skip if already populated.
  #   2. `gh pr list --head <goal_branch>` — recovery path when state.json
  #      lost the field (e.g. older goals from before this change).
  #   3. Create a fresh draft PR.
  local existing_url existing_num
  existing_url=$(read_state_field "goalPrUrl")
  if [ -n "$existing_url" ]; then
    return 0
  fi

  # Goal branch must exist on origin before we can open a PR.
  if ! git ls-remote --exit-code --heads origin "$goal_branch" >/dev/null 2>&1; then
    return 0
  fi

  # Recovery: PR may already exist from a prior tick that didn't persist the
  # URL. Match by head ref.
  existing_num=$(gh pr list --head "$goal_branch" --state open --json number --jq '.[0].number // empty' 2>/dev/null || echo "")
  if [ -n "$existing_num" ] && [[ "$existing_num" =~ ^[0-9]+$ ]]; then
    existing_url=$(gh pr view "$existing_num" --json url --jq .url 2>/dev/null || echo "")
  else
    local title body goal_issue_number
    title="goal: ${goal_id}"
    goal_issue_number=$(read_state_field "goalIssueNumber")
    if [ -n "$goal_issue_number" ] && [ "$goal_issue_number" != "0" ]; then
      body=$(printf "Tracking integration PR for goal **%s**.\n\nChild task PRs merge into \`%s\`. This PR is held in **draft** until every task is complete, then promoted to ready-for-review by goal-tick.\n\nCloses #%s\n" "$goal_id" "$goal_branch" "$goal_issue_number")
    else
      body=$(printf "Tracking integration PR for goal **%s**.\n\nChild task PRs merge into \`%s\`. Held in **draft** until every task is complete.\n" "$goal_id" "$goal_branch")
    fi
    existing_url=$(gh pr create \
      --draft \
      --head "$goal_branch" \
      --base "$default_branch" \
      --title "$title" \
      --body "$body" 2>/dev/null || echo "")
    if [ -z "$existing_url" ]; then
      echo "[goal-tick] ensure_goal_pr: gh pr create failed (continuing without goal PR)"
      return 0
    fi
    echo "[goal-tick] opened draft goal PR ${existing_url} for ${goal_id}"
  fi

  # Persist URL into state.json so subsequent ticks skip the lookup.
  set_state_field "goalPrUrl" "$existing_url"
}

list_goal_issues() {
  # Up to 100 goal-labelled issues. PRs filtered out. Also filters out the
  # umbrella goal issue (if any) — it shares the `goal:<id>` label so the
  # dashboard groups it under the goal, but it must NOT count as a child
  # task: while the umbrella is open the "all child tasks closed" finalize
  # check would never fire (the umbrella only closes on goal-PR merge,
  # which only happens during finalize — deadlock).
  local exclude
  exclude=$(read_state_field "goalIssueNumber")
  gh api \
    "repos/{owner}/{repo}/issues?labels=${label}&state=all&per_page=100" \
    --jq '[.[] | select(.pull_request == null) | {number, state: (.state | ascii_upcase), labels: [.labels[].name]}]' \
    | EXCLUDE="$exclude" python3 -c "
import json, os, sys
data = json.load(sys.stdin)
ex = os.environ.get('EXCLUDE', '')
if ex:
    try:
        ex_num = int(ex)
        data = [i for i in data if i['number'] != ex_num]
    except ValueError:
        pass
print(json.dumps(data))
"
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

# Open the umbrella goal issue on the first active tick (idempotent — no-op if
# state.json already has goalIssueNumber). The dashboard renders this issue as
# the goal's "row" with kody:building status; it auto-closes when the final
# goal PR merges via the `Closes #N` we add to that PR's body. Doing this here
# (before list_goal_issues) ensures the umbrella exists before we start
# counting child tasks, so list_goal_issues can filter it out cleanly.
ensure_goal_issue

# Open the draft goal PR if the goal branch already exists. Must run BEFORE
# any of the early exits below (in_flight check, no-undispatched-task idle,
# etc.) — otherwise active goals that always have a task in flight would
# never get past the in_flight gate to reach the late call site, leaving
# the umbrella row without its branch + preview anchor in the dashboard.
# `ensure_goal_pr` is a safe no-op when the branch hasn't been created yet
# (the lazy-branch-creation block at the dispatch site handles that case;
# the next tick picks up the PR creation here).
ensure_goal_pr

# Merge ready goal-task PRs into the goal branch. We own the merge here
# instead of relying on GitHub's `--auto` flag (which requires the repo's
# "Allow auto-merge" setting and silently no-ops when disabled). Only merge
# non-draft PRs with mergeable=MERGEABLE and mergeStateStatus=CLEAN — i.e.
# all required checks passed and there are no conflicts. Anything else
# (BLOCKED, DIRTY, BEHIND, UNSTABLE, draft) is left for the operator.
open_prs=$(gh pr list --base "$goal_branch" --state open --limit 50 \
  --json number,isDraft,mergeable,mergeStateStatus 2>/dev/null || echo "[]")
echo "$open_prs" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for pr in data:
    if pr.get('isDraft'): continue
    if pr.get('mergeable') != 'MERGEABLE': continue
    if pr.get('mergeStateStatus') != 'CLEAN': continue
    print(pr['number'])
" | while read -r pr_num; do
  [ -n "$pr_num" ] || continue
  echo "[goal-tick] merging PR #${pr_num} into ${goal_branch}"
  if ! gh pr merge "$pr_num" --squash --delete-branch >/dev/null 2>&1; then
    echo "[goal-tick] failed to merge PR #${pr_num} (continuing)"
  fi
done

# Close dispatched task issues whose PR has merged into the goal branch.
# `Closes #N` in the PR body only auto-closes the issue when the PR merges
# into the default branch — goal-task PRs target the goal branch, so we must
# close the issues explicitly. Without this, in_flight stays > 0 forever and
# the goal stalls after task 1. We accept the linkage from either:
#   - `Closes|Fixes|Resolves #N` in the PR body (authoritative), OR
#   - leading number on the head ref (kody convention: `<issue>-<slug>`).
merged_prs=$(gh pr list --base "$goal_branch" --state merged --limit 50 --json number,headRefName,body 2>/dev/null || echo "[]")
echo "$merged_prs" | python3 -c "
import json, re, sys
data = json.load(sys.stdin)
seen = set()
for pr in data:
    n = None
    body = pr.get('body') or ''
    m = re.search(r'(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b', body)
    if m:
        n = int(m.group(1))
    else:
        bm = re.match(r'^(\d+)-', pr.get('headRefName') or '')
        if bm:
            n = int(bm.group(1))
    if n and n not in seen:
        seen.add(n)
        print(n)
" | while read -r issue_num; do
  [ -n "$issue_num" ] || continue
  state=$(gh issue view "$issue_num" --json state --jq .state 2>/dev/null || echo "")
  if [ "$state" = "OPEN" ]; then
    echo "[goal-tick] closing #${issue_num} (PR merged into ${goal_branch})"
    gh issue close "$issue_num" \
      --comment "_Closed by goal-tick: PR for this task merged into \`${goal_branch}\`._" \
      >/dev/null 2>&1 || echo "[goal-tick] failed to close #${issue_num} (continuing)"
  fi
done

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

  # Promote (or open) the goal PR. The active path opens this PR as a draft
  # once the goal branch exists, so by finalize it almost always already
  # exists — we just mark it ready-for-review and refresh the body. Older
  # goals from before the early-PR change may still need first-time creation
  # here as a fallback.
  goal_pr_url=""
  if git ls-remote --exit-code --heads origin "$goal_branch" >/dev/null 2>&1; then
    existing_pr=$(gh pr list --head "$goal_branch" --state open --json number,url,isDraft --jq '.[0]' 2>/dev/null || echo "")
    title="goal: ${goal_id}"
    goal_issue_number=$(read_state_field "goalIssueNumber")
    # `Closes #N` auto-closes the umbrella goal issue on PR merge — that's
    # how the dashboard learns the goal is done. Skip the line gracefully
    # if no umbrella issue was ever opened (older goals from before this
    # change, or `gh issue create` failed silently during a tick).
    if [ -n "$goal_issue_number" ] && [ "$goal_issue_number" != "0" ]; then
      body=$(printf "Final integration PR for goal **%s**.\n\nAll task issues are closed and merged into \`%s\`. Ready for review.\n\nCloses #%s\n" "$goal_id" "$goal_branch" "$goal_issue_number")
    else
      body=$(printf "Final integration PR for goal **%s**.\n\nAll task issues are closed and merged into \`%s\`. Ready for review.\n" "$goal_id" "$goal_branch")
    fi
    if [ -z "$existing_pr" ] || [ "$existing_pr" = "null" ]; then
      goal_pr_url=$(gh pr create \
        --head "$goal_branch" \
        --base "$default_branch" \
        --title "$title" \
        --body "$body" 2>/dev/null || echo "")
    else
      existing_num=$(echo "$existing_pr" | python3 -c "import json,sys; print(json.load(sys.stdin).get('number',''))")
      goal_pr_url=$(echo "$existing_pr" | python3 -c "import json,sys; print(json.load(sys.stdin).get('url',''))")
      is_draft=$(echo "$existing_pr" | python3 -c "import json,sys; print('true' if json.load(sys.stdin).get('isDraft') else 'false')")
      # Refresh the body with the finalize copy so reviewers see the right
      # framing. Best-effort — failure is non-fatal.
      gh pr edit "$existing_num" --body "$body" >/dev/null 2>&1 || true
      if [ "$is_draft" = "true" ]; then
        echo "[goal-tick] promoting draft goal PR #${existing_num} to ready-for-review"
        gh pr ready "$existing_num" >/dev/null 2>&1 \
          || echo "[goal-tick] failed to mark PR #${existing_num} ready (continuing)"
      fi
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

# Lazy goal-branch creation: only spin up origin/goal-<id> at the moment we're
# about to dispatch the first task. Goals whose ticks never dispatch (every
# task closed as won't-fix, or every open task already has goal-runner:failed)
# never produce an orphan branch on origin. Idempotent: if origin/goal-<id>
# already exists we skip. Failure here is non-fatal — ensureFeatureBranch in
# the dispatched run falls back to forking from defaultBranch.
git fetch origin --quiet 2>/dev/null || true
if git rev-parse --verify --quiet "refs/remotes/origin/${goal_branch}" >/dev/null 2>&1; then
  echo "[goal-tick] origin/${goal_branch} already exists — leaving as-is"
else
  if ! git rev-parse --verify --quiet "refs/remotes/origin/${default_branch}" >/dev/null 2>&1; then
    echo "[goal-tick] cannot create goal branch: origin/${default_branch} missing"
  else
    echo "[goal-tick] creating origin/${goal_branch} from origin/${default_branch}"
    if ! git push origin "refs/remotes/origin/${default_branch}:refs/heads/${goal_branch}" --quiet 2>&1; then
      echo "[goal-tick] push of ${goal_branch} failed — task dispatch will fall back to defaultBranch"
    fi
  fi
fi
# (`ensure_goal_pr` runs at the top of the active path so it's reached even
# when this tick exits early via the in_flight gate; not duplicated here.)

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
