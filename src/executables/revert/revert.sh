#!/usr/bin/env bash
#
# revert: stage `git revert` of one or more commits on the PR branch.
#
# Runs as a preflight shell entry after revertFlow has validated inputs and
# checked out the branch. revertFlow:
#   - Resolved every requested SHA to its full form and re-set
#     ctx.args.shas to a whitespace-separated list (we read it via
#     KODY_ARG_SHAS).
#   - Set ctx.skipAgent=true and ctx.data.commitMessage already, so the
#     agent never runs and commitAndPush will use that message.
#
# This script does only the staging — `--no-commit` so commitAndPush
# (postflight) makes the actual commit. That keeps kody's invariant
# intact (only commitAndPush commits) and means the message comes from
# revertFlow, not from git's auto-generated revert subject.
#
# Exits:
#   0   — staged successfully
#   1+  — git revert failed (executor surfaces stderr; postflight bails)

set -euo pipefail

shas="${KODY_ARG_SHAS:-}"
if [[ -z "$shas" ]]; then
  echo "revert.sh: KODY_ARG_SHAS is empty (revertFlow should have set it)" >&2
  exit 64
fi

# shellcheck disable=SC2086 # Intentional word-splitting on whitespace-separated SHAs.
git revert --no-commit --no-edit $shas

echo "revert.sh: staged revert of: $shas"
