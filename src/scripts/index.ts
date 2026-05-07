/**
 * Script catalog — maps profile-declared names to implementations.
 * Adding a new script: create src/scripts/<name>.ts, export it, register
 * here. Any profile referencing an unregistered script name fails at load.
 */

import type { PostflightScript, PreflightScript } from "../executables/types.js"
import { abortUnfinishedGitOps } from "./abortUnfinishedGitOps.js"
import { advanceFlow } from "./advanceFlow.js"
import { buildSyntheticPlugin } from "./buildSyntheticPlugin.js"
import { checkCoverageWithRetry } from "./checkCoverageWithRetry.js"
import { classifyByLabel } from "./classifyByLabel.js"
import { commitAndPush } from "./commitAndPush.js"
import { composePrompt } from "./composePrompt.js"
import { diagMcp } from "./diagMcp.js"
import { discoverQaContext } from "./discoverQaContext.js"
import { dispatch } from "./dispatch.js"
import { dispatchClassified } from "./dispatchClassified.js"
import { dispatchJobFileTicks } from "./dispatchJobFileTicks.js"
import { dispatchJobTicks } from "./dispatchJobTicks.js"
import { ensureMemorizePr } from "./ensureMemorizePr.js"
import { ensurePr } from "./ensurePr.js"
import { finishFlow } from "./finishFlow.js"
import { fixCiFlow } from "./fixCiFlow.js"
import { fixFlow } from "./fixFlow.js"
import { initFlow } from "./initFlow.js"
import { loadConventions } from "./loadConventions.js"
import { loadCoverageRules } from "./loadCoverageRules.js"
import { loadIssueContext } from "./loadIssueContext.js"
import { loadIssueStateComment } from "./loadIssueStateComment.js"
import { loadJobFromFile } from "./loadJobFromFile.js"
import { loadPriorArt } from "./loadPriorArt.js"
import { loadQaGuide } from "./loadQaGuide.js"
import { loadTaskState } from "./loadTaskState.js"
import { loadVaultContext } from "./loadVaultContext.js"
import { markFlowSuccess } from "./markFlowSuccess.js"
import { memorizeFlow } from "./memorizeFlow.js"
import { mergeReleasePr } from "./mergeReleasePr.js"
import { mirrorStateToPr } from "./mirrorStateToPr.js"
import { notifyTerminal } from "./notifyTerminal.js"
import { parseAgentResult } from "./parseAgentResult.js"
import { parseIssueStateFromAgentResult } from "./parseIssueStateFromAgentResult.js"
import { parseJobStateFromAgentResult } from "./parseJobStateFromAgentResult.js"
import { parseReproOutput } from "./parseReproOutput.js"
import { persistArtifacts } from "./persistArtifacts.js"
import { persistFlowState } from "./persistFlowState.js"
import { postIssueComment } from "./postIssueComment.js"
import { postPlanComment } from "./postPlanComment.js"
import { postResearchComment } from "./postResearchComment.js"
import { postReviewResult } from "./postReviewResult.js"
import { recordClassification } from "./recordClassification.js"
import { recordOutcome } from "./recordOutcome.js"
import { requireFeedbackActions } from "./requireFeedbackActions.js"
import { requirePlanDeviations } from "./requirePlanDeviations.js"
import { resolveArtifacts } from "./resolveArtifacts.js"
import { resolveFlow } from "./resolveFlow.js"
import { resolvePreviewUrl } from "./resolvePreviewUrl.js"
import { revertFlow } from "./revertFlow.js"
import { reviewFlow } from "./reviewFlow.js"
import { runFlow } from "./runFlow.js"
import { saveTaskState } from "./saveTaskState.js"
import { setCommentTarget } from "./setCommentTarget.js"
import { setLifecycleLabel } from "./setLifecycleLabel.js"
import { skipAgent } from "./skipAgent.js"
import { stageMergeConflicts } from "./stageMergeConflicts.js"
import { startFlow } from "./startFlow.js"
import { syncFlow } from "./syncFlow.js"
import { verify } from "./verify.js"
import { verifyReproFails } from "./verifyReproFails.js"
import { waitForCi } from "./waitForCi.js"
import { watchStalePrsFlow } from "./watchStalePrsFlow.js"
import { writeIssueStateComment } from "./writeIssueStateComment.js"
import { writeJobStateFile } from "./writeJobStateFile.js"
import { writeRunSummary } from "./writeRunSummary.js"

export const preflightScripts: Record<string, PreflightScript> = {
  runFlow,
  fixFlow,
  fixCiFlow,
  resolveFlow,
  revertFlow,
  reviewFlow,
  syncFlow,
  initFlow,
  watchStalePrsFlow,
  memorizeFlow,
  loadTaskState,
  loadVaultContext,
  loadIssueContext,
  loadIssueStateComment,
  loadJobFromFile,
  loadConventions,
  loadCoverageRules,
  loadPriorArt,
  loadQaGuide,
  buildSyntheticPlugin,
  resolveArtifacts,
  discoverQaContext,
  resolvePreviewUrl,
  composePrompt,
  setCommentTarget,
  setLifecycleLabel,
  skipAgent,
  classifyByLabel,
  diagMcp,
  dispatchJobTicks,
  dispatchJobFileTicks,
}

export const postflightScripts: Record<string, PostflightScript> = {
  parseAgentResult,
  parseIssueStateFromAgentResult,
  parseJobStateFromAgentResult,
  parseReproOutput,
  writeIssueStateComment,
  writeJobStateFile,
  requireFeedbackActions,
  requirePlanDeviations,
  verify,
  verifyReproFails,
  checkCoverageWithRetry,
  abortUnfinishedGitOps,
  stageMergeConflicts,
  commitAndPush,
  ensurePr,
  ensureMemorizePr,
  postIssueComment,
  postPlanComment,
  postResearchComment,
  postReviewResult,
  persistArtifacts,
  writeRunSummary,
  saveTaskState,
  mirrorStateToPr,
  startFlow,
  dispatch,
  finishFlow,
  advanceFlow,
  persistFlowState,
  recordClassification,
  dispatchClassified,
  notifyTerminal,
  recordOutcome,
  mergeReleasePr,
  waitForCi,
  markFlowSuccess,
}

export const allScriptNames: Set<string> = new Set([
  ...Object.keys(preflightScripts),
  ...Object.keys(postflightScripts),
])
