/**
 * Postflight: remove a kody-owned label from the target issue/PR.
 * Mirror of `setLifecycleLabel` — auto-paired by the profile loader so
 * every executable that stamps a lifecycle label in preflight clears it
 * in postflight, regardless of success/failure.
 *
 * Expected `with` shape:
 *   - label: required, string, must start with KODY_NAMESPACE
 *
 * Best-effort — failures log but never throw. Reads the target number
 * from `ctx.args.issue` (preferred) or `ctx.args.pr`. PRs and issues
 * share the GitHub number space, so `gh issue edit` works for both.
 */

import type { PostflightScript } from "../executables/types.js"
import { KODY_NAMESPACE, removeKodyLabel } from "../lifecycleLabels.js"

export const clearLifecycleLabel: PostflightScript = async (ctx, _profile, _agentResult, args) => {
  const label = args?.label
  if (typeof label !== "string" || !label.startsWith(KODY_NAMESPACE)) {
    process.stderr.write(
      `[kody] clearLifecycleLabel: missing or invalid "label" arg (must start with "${KODY_NAMESPACE}"): ${String(label)}\n`,
    )
    return
  }

  const issueNumber = resolveTargetNumber(ctx.args)
  if (issueNumber === undefined) return

  removeKodyLabel(issueNumber, label, ctx.cwd)
}

function resolveTargetNumber(args: Record<string, unknown>): number | undefined {
  const issue = args.issue
  if (typeof issue === "number" && Number.isFinite(issue)) return issue
  const pr = args.pr
  if (typeof pr === "number" && Number.isFinite(pr)) return pr
  return undefined
}
