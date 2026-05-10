/**
 * Flow script for the `run` executable.
 * Loads the issue, creates/checks out a feature branch, posts the "started"
 * comment. Issue number lives in `ctx.args.issue`.
 */

import { ensureFeatureBranch, UncommittedChangesError } from "../branch.js"
import type { PreflightScript } from "../executables/types.js"
import { getRunUrl } from "../gha.js"
import { getIssue, postIssueComment } from "../issue.js"

export const runFlow: PreflightScript = async (ctx) => {
  const issueNumber = ctx.args.issue as number

  const issue = getIssue(issueNumber, ctx.cwd)
  ctx.data.issue = issue
  ctx.data.commentTargetType = "issue"
  ctx.data.commentTargetNumber = issueNumber

  // Resolve the base branch in two stages:
  //   1. Issue labels — when goal-tick has dispatched this task, the issue
  //      carries `goal-runner:dispatched` AND a `goal:<id>` label. We treat
  //      that combo as the durable signal and fork from `goal-<id>`. This
  //      survives the classify → bug/feature/chore container hop, which
  //      strips comment-supplied flags, because the labels live on the
  //      issue itself.
  //   2. Optional --base CLI flag — kept as an explicit escape hatch and
  //      validated against the goal-branch allowlist so comment-driven
  //      dispatch can't redirect kody onto an arbitrary branch.
  const labelBase = resolveBaseFromLabels(issue.labels ?? [])
  const argBase = resolveBaseOverride(ctx.args.base as string | undefined)
  const baseRaw = ctx.args.base as string | undefined
  if (baseRaw && !argBase) {
    process.stderr.write(`[kody runFlow] ignoring --base "${baseRaw}" (must match /^goal-[a-z0-9-]+$/)\n`)
  }
  const base = labelBase ?? argBase
  if (base) {
    ctx.data.baseBranch = base
    process.stderr.write(
      `[kody runFlow] resolved base branch: ${base} (${labelBase ? "from labels" : "from --base"})\n`,
    )
  }

  try {
    const branchInfo = ensureFeatureBranch(
      issueNumber,
      issue.title,
      ctx.config.git.defaultBranch,
      ctx.cwd,
      base ?? undefined,
    )
    ctx.data.branch = branchInfo.branch
  } catch (err) {
    if (err instanceof UncommittedChangesError) {
      ctx.output.exitCode = 5
      ctx.output.reason = err.message
      ctx.skipAgent = true
      tryPost(issueNumber, `⚠️ kody refused to start: ${err.message}`, ctx.cwd)
      return
    }
    throw err
  }

  const runUrl = getRunUrl()
  const startMsg = runUrl
    ? `⚙️ kody started — branch \`${ctx.data.branch}\`, run ${runUrl}`
    : `⚙️ kody started — branch \`${ctx.data.branch}\``
  tryPost(issueNumber, startMsg, ctx.cwd)
}

function tryPost(issueNumber: number, body: string, cwd?: string): void {
  try {
    postIssueComment(issueNumber, body, cwd)
  } catch {
    /* best effort */
  }
}

/**
 * Validate a --base override. Returns the value if it matches the goal
 * branch convention, otherwise null. Keeping this allowlist tight prevents
 * comment-driven redirection of kody onto arbitrary branches.
 */
export function resolveBaseOverride(value: string | undefined): string | null {
  if (!value) return null
  return /^goal-[a-z0-9-]+$/.test(value) ? value : null
}

/**
 * Derive the goal branch from issue labels. Active only when both signals
 * are present:
 *   - `goal-runner:dispatched` — confirms the goal-runner driver dispatched
 *     this task (a manual @kody on a goal-labelled issue should keep the
 *     per-issue / off-main flow).
 *   - `goal:<id>` — names the goal whose shared branch we should fork from.
 *
 * Returns `goal-<id>` if both labels are found and the id is well-formed,
 * else null. The well-formed check matches `resolveBaseOverride`'s allowlist
 * so the eventual git fetch / fork can't be redirected by a malformed label.
 */
export function resolveBaseFromLabels(labels: string[]): string | null {
  if (!labels.includes("goal-runner:dispatched")) return null
  const goalLabel = labels.find((l) => l.startsWith("goal:"))
  if (!goalLabel) return null
  const goalId = goalLabel.slice("goal:".length)
  if (!/^[a-z0-9-]+$/.test(goalId)) return null
  return `goal-${goalId}`
}
