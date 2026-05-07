/**
 * Postflight: extract the agent's proposed next state from a fenced code
 * block, validate it, and place it on ctx.data.nextJobState. Mirror of
 * `parseIssueStateFromAgentResult` for the file-based job model.
 *
 * Reads previous rev from ctx.data.jobState (loaded by loadJobFromFile).
 *
 * Script args (via `with:`):
 *   fenceLabel  required — e.g. "kody-job-next-state"
 *
 * Reads   ctx.data.jobState
 * Writes  ctx.data.nextJobState ({ version, rev, cursor, data, done })
 *         ctx.data.nextStateParseError on failure
 */

import type { PostflightScript } from "../executables/types.js"
import type { StateEnvelope } from "./issueStateComment.js"
import type { LoadedJobState } from "./jobState/index.js"

interface PartialEnvelope {
  cursor: string
  data: Record<string, unknown>
  done: boolean
}

function isPartialEnvelope(x: unknown): x is PartialEnvelope {
  if (x === null || typeof x !== "object") return false
  const o = x as Record<string, unknown>
  return (
    typeof o.cursor === "string" &&
    o.cursor.length > 0 &&
    typeof o.done === "boolean" &&
    o.data !== null &&
    typeof o.data === "object" &&
    !Array.isArray(o.data)
  )
}

export const parseJobStateFromAgentResult: PostflightScript = async (ctx, _profile, agentResult, args) => {
  const fenceLabel = String(args?.fenceLabel ?? "")
  if (!fenceLabel) {
    throw new Error("parseJobStateFromAgentResult: `with.fenceLabel` is required")
  }

  if (!agentResult) {
    ctx.data.nextStateParseError = "agent did not run"
    return
  }

  const fenceRegex = new RegExp(`\`\`\`${escapeRegex(fenceLabel)}\\s*\\n([\\s\\S]*?)\\n\`\`\``, "m")
  const match = fenceRegex.exec(agentResult.finalText)
  if (!match) {
    ctx.data.nextStateParseError = `agent did not emit a \`${fenceLabel}\` fenced block`
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1]!.trim())
  } catch (err) {
    ctx.data.nextStateParseError = `state JSON parse error: ${err instanceof Error ? err.message : String(err)}`
    return
  }

  if (!isPartialEnvelope(parsed)) {
    ctx.data.nextStateParseError = "state must be an object with string `cursor`, object `data`, and boolean `done`"
    return
  }

  const loaded = ctx.data.jobState as LoadedJobState | null | undefined
  const prevRev = loaded?.state.rev ?? 0

  const next: StateEnvelope = {
    version: 1,
    rev: prevRev + 1,
    cursor: parsed.cursor,
    data: parsed.data,
    done: parsed.done,
  }
  ctx.data.nextJobState = next
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
}
