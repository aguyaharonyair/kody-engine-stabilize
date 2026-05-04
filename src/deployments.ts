/**
 * GitHub Deployments helpers.
 *
 * Provider-agnostic: Vercel, Netlify, Cloudflare Pages, etc. all create
 * GitHub Deployments with `environment_url`. This is the contract; we read
 * the canonical record rather than scraping bot comments.
 *
 * Pure functions over the `gh` CLI — no ctx, no orchestration.
 */

import { gh } from "./issue.js"

interface DeploymentRef {
  id: number
}

interface DeploymentStatus {
  state: string
  environment_url: string | null
}

/**
 * Find the most recent successful Preview deployment URL for the PR's
 * head commit. Returns `null` if there is no PR, no Preview deployment,
 * none have a successful status, or any API call fails.
 */
export function findPreviewDeploymentUrl(prNumber: number, cwd?: string): string | null {
  const sha = getPrHeadSha(prNumber, cwd)
  if (!sha) return null

  const raw = safeGh(
    ["api", `repos/{owner}/{repo}/deployments?sha=${sha}&environment=Preview&per_page=10`],
    cwd,
  )
  if (!raw) return null

  let deployments: DeploymentRef[]
  try {
    deployments = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(deployments) || deployments.length === 0) return null

  for (const d of deployments) {
    const url = latestSuccessUrl(d.id, cwd)
    if (url) return url
  }
  return null
}

function getPrHeadSha(prNumber: number, cwd?: string): string | null {
  const out = safeGh(["api", `repos/{owner}/{repo}/pulls/${prNumber}`, "--jq", ".head.sha"], cwd)
  if (!out) return null
  const trimmed = out.trim()
  return trimmed.length > 0 ? trimmed : null
}

function latestSuccessUrl(deploymentId: number, cwd?: string): string | null {
  const raw = safeGh(
    ["api", `repos/{owner}/{repo}/deployments/${deploymentId}/statuses?per_page=10`],
    cwd,
  )
  if (!raw) return null

  let statuses: DeploymentStatus[]
  try {
    statuses = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(statuses)) return null

  // GitHub returns statuses newest-first.
  for (const s of statuses) {
    if (s.state === "success" && typeof s.environment_url === "string" && s.environment_url.length > 0) {
      return s.environment_url
    }
  }
  return null
}

function safeGh(args: string[], cwd?: string): string | null {
  try {
    return gh(args, { cwd })
  } catch {
    return null
  }
}
