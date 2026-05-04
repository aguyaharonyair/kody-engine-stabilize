/**
 * Postflight: persist ctx.data.nextMissionState via the configured
 * `MissionStateBackend`. Mirror of `writeIssueStateComment` for the
 * file-based mission model.
 *
 * Backends decide how durability works (contents-API commit, local file,
 * Actions cache, …). This script just relays prev/next; the backend skips
 * no-op writes when state is structurally unchanged.
 *
 * If a prior preflight reported a parse error (ctx.data.nextStateParseError),
 * logs it and surfaces exit code 1 so the run fails loudly rather than
 * silently no-op'ing on a broken agent response.
 */

import type { PostflightScript } from "../executables/types.js"
import type { StateEnvelope } from "./issueStateComment.js"
import { type LoadedMissionState, resolveBackend } from "./missionState/index.js"

export const writeMissionStateFile: PostflightScript = async (ctx, _profile, _agentResult, args) => {
  const parseError = ctx.data.nextStateParseError as string | undefined
  if (parseError) {
    process.stderr.write(`[kody] mission state write skipped: ${parseError}\n`)
    if (ctx.output.exitCode === 0) ctx.output.exitCode = 1
    if (!ctx.output.reason) ctx.output.reason = `next-state parse failed: ${parseError}`
    return
  }

  const next = ctx.data.nextMissionState as StateEnvelope | undefined
  if (!next) {
    // Agent emitted nothing new; leave the state alone.
    return
  }

  const loaded = ctx.data.missionState as LoadedMissionState | undefined
  if (!loaded) {
    throw new Error("writeMissionStateFile: ctx.data.missionState missing — preflight must run first")
  }

  // Backend selection mirrors the preflight load. We re-resolve here rather
  // than pass through ctx.data because the backend is cheap to construct
  // and stateless per-tick (lifecycle state lives on the dispatcher's
  // single instance — see dispatchMissionFileTicks).
  const missionsDir = String(args?.missionsDir ?? ".kody/missions")
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, missionsDir })
  await backend.save(loaded, next)
}
