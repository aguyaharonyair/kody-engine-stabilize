#!/usr/bin/env bash
#
# goal-scheduler: enumerate every goal state file under .kody/goals/ and
# dispatch goal-tick once for each whose state == "active". Runs as a
# scheduled executable (cron `*/5 * * * *`). No agent.
#
# A failed individual tick logs and continues — one stuck goal must not
# starve the rest.

set -euo pipefail

goals_dir=".kody/goals"

if [ ! -d "$goals_dir" ]; then
  echo "[goal-scheduler] no $goals_dir — nothing to schedule"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

shopt -s nullglob
state_files=("$goals_dir"/*/state.json)
shopt -u nullglob

if [ "${#state_files[@]}" = "0" ]; then
  echo "[goal-scheduler] no goal state files yet"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

active=0
for state_file in "${state_files[@]}"; do
  [ -f "$state_file" ] || continue
  goal_id=$(basename "$(dirname "$state_file")")

  state=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('state',''))" "$state_file" 2>/dev/null || echo "")

  if [ "$state" != "active" ]; then
    continue
  fi

  active=$((active + 1))
  echo "[goal-scheduler] → tick $goal_id"

  # Ensure the shared goal branch exists on origin before we tick. This is
  # the integration target for every task PR under this goal. Idempotent:
  # if origin/goal-<id> already exists we skip. We deliberately create from
  # the latest origin/<defaultBranch> so the goal branch starts from a
  # known-clean base; subsequent task PRs build on top.
  goal_branch="goal-${goal_id}"
  default_branch="${KODY_CFG_GIT_DEFAULTBRANCH:-main}"

  # Best-effort fetch so origin refs are fresh.
  git fetch origin --quiet 2>/dev/null || true

  if git rev-parse --verify --quiet "refs/remotes/origin/${goal_branch}" >/dev/null 2>&1; then
    echo "[goal-scheduler] origin/${goal_branch} already exists — leaving as-is"
  else
    if ! git rev-parse --verify --quiet "refs/remotes/origin/${default_branch}" >/dev/null 2>&1; then
      echo "[goal-scheduler] cannot create goal branch: origin/${default_branch} missing"
    else
      echo "[goal-scheduler] creating origin/${goal_branch} from origin/${default_branch}"
      # Push a new ref directly without checking it out — avoids touching the
      # working tree, which other ticks/scripts in this same scheduler run
      # may rely on. Failures here are logged and we proceed; goal-tick will
      # still dispatch task issues, and ensureFeatureBranch will fall back to
      # forking from defaultBranch when origin/goal-<id> is absent.
      if ! git push origin "refs/remotes/origin/${default_branch}:refs/heads/${goal_branch}" --quiet 2>&1; then
        echo "[goal-scheduler] push of ${goal_branch} failed (will retry next tick)"
      fi
    fi
  fi

  # Run the tick. Top-level kody invocation is `kody <executable>` —
  # there's no `dispatch` subcommand. A non-zero exit logs and continues
  # so one stuck goal doesn't starve the rest of the schedule.
  if ! kody goal-tick --goal "$goal_id"; then
    echo "[goal-scheduler] tick $goal_id failed (continuing)"
  fi
done

echo "[goal-scheduler] ticked $active active goal(s) of ${#state_files[@]} total"
echo "KODY_SKIP_AGENT=true"
exit 0
