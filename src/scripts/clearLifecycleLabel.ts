/**
 * Postflight mirror of `setLifecycleLabel`. Auto-paired by the profile
 * loader so any executable that stamps a `kody:*` lifecycle label in
 * preflight clears it on exit, regardless of success/failure.
 */

import type { PostflightScript } from "../executables/types.js"
import { KODY_NAMESPACE, removeLabel } from "../lifecycleLabels.js"

export const clearLifecycleLabel: PostflightScript = async (ctx, _profile, _agentResult, args) => {
  const label = args?.label
  if (typeof label !== "string" || !label.startsWith(KODY_NAMESPACE)) return
  const target = (ctx.args.issue ?? ctx.args.pr) as number | undefined
  if (typeof target !== "number" || !Number.isFinite(target)) return
  removeLabel(target, label, ctx.cwd)
}
