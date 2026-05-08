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

  // Optional --base override (used by goal-tick to pass `goal-<id>` so the
  // task feature branch forks from the shared goal branch and the PR targets
  // it). Validate the value tightly — comment dispatch is the entry point,
  // so an unrestricted base would let any commenter redirect kody at an
  // arbitrary branch. Allowed pattern: `goal-<slug>` only.
  const baseRaw = ctx.args.base as string | undefined
  const base = resolveBaseOverride(baseRaw)
  if (baseRaw && !base) {
    process.stderr.write(`[kody runFlow] ignoring --base "${baseRaw}" (must match /^goal-[a-z0-9-]+$/)\n`)
  }
  if (base) {
    ctx.data.baseBranch = base
  }

  try {
    const branchInfo = ensureFeatureBranch(issueNumber, issue.title, ctx.config.git.defaultBranch, ctx.cwd, base ?? undefined)
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
