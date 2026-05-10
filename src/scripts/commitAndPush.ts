/**
 * Postflight: commit whatever is staged and push the branch. Records the
 * commit result on ctx.data.commitResult for downstream postflights
 * (ensurePr, postIssueComment) to consume.
 *
 * Staging and pre-commit cleanup are the responsibility of earlier
 * postflight entries (e.g. abortUnfinishedGitOps for normal flows,
 * stageMergeConflicts for merge flows). This script does not branch on
 * executable identity.
 *
 * Commit message source (in priority order):
 *   1. ctx.data.commitMessage (agent's COMMIT_MSG line, parsed by parseAgentResult)
 *   2. generic fallback ("chore: kody changes")
 */

import {
  commitAndPush as doCommitAndPush,
  hasCommitsAhead,
  isForbiddenPath,
  listChangedFiles,
  listFilesInCommit,
} from "../commit.js"
import type { PostflightScript } from "../executables/types.js"

const DEFAULT_COMMIT_MESSAGE = "chore: kody changes"

export const commitAndPush: PostflightScript = async (ctx) => {
  const branch = ctx.data.branch as string | undefined
  if (!branch) {
    ctx.data.commitResult = { committed: false, pushed: false }
    return
  }

  // If an earlier postflight (e.g. requireFeedbackActions) flipped agentDone
  // to false, we must not commit the agent's edits. Leave them in the working
  // tree so the failure reason is surfaced without polluting the branch.
  //
  // Exception: when agentDone=false ONLY because the agent forgot to emit the
  // DONE/COMMIT_MSG/PR_SUMMARY contract markers (agentMarkerMissing=true), the
  // work itself is valid — the model just stopped at a prose summary instead of
  // the structured tail. Salvage by committing+pushing anyway; ensurePr will
  // open a draft PR (failureReason → draft) so the operator can inspect the
  // diff. Without this salvage, hours of agent work get thrown away whenever
  // a model drops the sentinel, which is the worst-of-both outcome — we paid
  // for the run, then discarded the result.
  const markerMissing = ctx.data.agentMarkerMissing === true
  if (ctx.data.agentDone === false && !markerMissing) {
    ctx.data.commitResult = { committed: false, pushed: false, skippedReason: "agentDone=false" }
    ctx.data.hasCommitsAhead = hasCommitsAhead(branch, ctx.config.git.defaultBranch, ctx.cwd)
    return
  }

  if (ctx.data.agentDone === false && markerMissing) {
    // Surface the salvage path for postIssueComment / observability. The
    // commit message falls back to DEFAULT_COMMIT_MESSAGE because the agent
    // didn't supply one — by definition there's no COMMIT_MSG marker.
    ctx.data.salvagedFromMissingMarker = true
  }

  const message = (ctx.data.commitMessage as string) || DEFAULT_COMMIT_MESSAGE

  try {
    const result = doCommitAndPush(branch, message, ctx.cwd)
    ctx.data.commitResult = result
    // After a successful commit the working tree is clean, so listChangedFiles
    // (which reads `git status`) returns []. Use the commit's own file list
    // so downstream postflights (verifyFixAlignment) know what we committed.
    // Fall back to working-tree status only if the commit was skipped.
    const postCommitFiles = result.committed ? listFilesInCommit("HEAD", ctx.cwd) : listChangedFiles(ctx.cwd)
    ctx.data.changedFiles = postCommitFiles.filter((f) => !isForbiddenPath(f))

    if (result.committed && !result.pushed) {
      // Commit landed locally but push failed (network, auth, branch
      // protection). Surface as a non-zero exit so the operator sees this
      // explicitly and downstream ensurePr / postIssueComment can branch.
      const reason = result.pushError ?? "push failed (no error detail)"
      ctx.data.commitCrash = reason
      if (ctx.output.exitCode === undefined || ctx.output.exitCode === 0) {
        ctx.output.exitCode = 4
      }
      if (!ctx.output.reason) ctx.output.reason = reason
      process.stderr.write(`[kody commitAndPush] ${reason}\n`)
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.data.commitCrash = reason
    ctx.data.commitResult = { committed: false, pushed: false }
    process.stderr.write(`[kody commitAndPush] failed: ${reason}\n`)
  }

  ctx.data.hasCommitsAhead = hasCommitsAhead(branch, ctx.config.git.defaultBranch, ctx.cwd)
}
