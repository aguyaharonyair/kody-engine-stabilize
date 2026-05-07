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
