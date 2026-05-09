/**
 * healthCheckFlow — preflight for the scheduled `health-check` executable.
 *
 * Scans open issues carrying any active kody:* lifecycle label, flags the
 * ones whose `updatedAt` is older than `staleHours` (default 6h), renders a
 * markdown digest, and writes it to `.kody/reports/health-check.md` (rolling
 * single file). The dashboard `/reports` page surfaces the file as-is.
 *
 * Diagnostic only — never auto-remediates. Operator reads the report and
 * decides what to nudge.
 *
 * Agent-free: sets ctx.skipAgent.
 *
 * Config:
 *   kody.config.json#health.staleHours    number, default 6
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

import { commitAndPush } from "../commit.js"
import type { PreflightScript } from "../executables/types.js"
import { gh, truncate } from "../issue.js"

const REPORT_PATH = ".kody/reports/health-check.md"
const COMMIT_MESSAGE = "chore(health-check): refresh kody task health report"

const ACTIVE_LABELS = [
  "kody:queued",
  "kody:running",
  "kody:fixing",
  "kody:resolving",
  "kody:reviewing",
  "kody:syncing",
  "kody:needs-fix",
] as const

interface HealthConfig {
  staleHours: number
}

function readHealthConfig(ctx: Parameters<PreflightScript>[0]): HealthConfig {
  const cfg = (ctx.config as unknown as Record<string, unknown>).health
  if (!cfg || typeof cfg !== "object") return { staleHours: 6 }
  const r = cfg as Record<string, unknown>
  const staleHours =
    typeof r.staleHours === "number" && r.staleHours > 0 ? Math.floor(r.staleHours) : 6
  return { staleHours }
}

interface IssueRow {
  number: number
  title: string
  url: string
  updatedAt: string
  hoursStale: number
  label: string
}

export function findActiveIssues(cwd: string, now: Date = new Date()): IssueRow[] {
  const rows: IssueRow[] = []
  const seen = new Set<number>()

  for (const label of ACTIVE_LABELS) {
    let raw = ""
    try {
      raw = gh(
        [
          "issue",
          "list",
          "--state",
          "open",
          "--label",
          label,
          "--limit",
          "100",
          "--json",
          "number,title,url,updatedAt",
        ],
        { cwd },
      )
    } catch {
      continue
    }
    let list: Array<{ number: number; title: string; url: string; updatedAt: string }>
    try {
      list = JSON.parse(raw)
    } catch {
      continue
    }
    if (!Array.isArray(list)) continue

    for (const issue of list) {
      if (seen.has(issue.number)) continue
      const ts = Date.parse(issue.updatedAt)
      if (!Number.isFinite(ts)) continue
      const hoursStale = Math.floor((now.getTime() - ts) / (60 * 60 * 1000))
      rows.push({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        updatedAt: issue.updatedAt,
        hoursStale,
        label,
      })
      seen.add(issue.number)
    }
  }

  return rows.sort((a, b) => b.hoursStale - a.hoursStale)
}

export function formatHealthReport(
  rows: IssueRow[],
  staleHours: number,
  now: Date = new Date(),
): string {
  const stuck = rows.filter((r) => r.hoursStale >= staleHours)
  const fresh = rows.filter((r) => r.hoursStale < staleHours)
  const stamp = now.toISOString()

  const lines: string[] = [
    "# Kody Task Health",
    "",
    `_Last run: ${stamp}_  `,
    `_Threshold: ${staleHours}h since last update_`,
    "",
  ]

  if (rows.length === 0) {
    lines.push("No open issues currently carry an active kody:* lifecycle label.")
    return `${lines.join("\n")}\n`
  }

  lines.push(
    `**Active tasks:** ${rows.length}  `,
    `**Stuck (>${staleHours}h):** ${stuck.length}`,
    "",
  )

  if (stuck.length > 0) {
    lines.push(`## Stuck tasks (>${staleHours}h)`, "")
    for (const r of stuck) {
      lines.push(
        `- [#${r.number}](${r.url}) \`${r.label}\` — *${truncate(r.title, 80)}* (${r.hoursStale}h stale, updated ${r.updatedAt})`,
      )
    }
    lines.push("")
  } else {
    lines.push("All active tasks were updated within the threshold.", "")
  }

  if (fresh.length > 0) {
    lines.push("## Fresh active tasks", "")
    for (const r of fresh) {
      lines.push(
        `- [#${r.number}](${r.url}) \`${r.label}\` — *${truncate(r.title, 80)}* (${r.hoursStale}h since last update)`,
      )
    }
    lines.push("")
  }

  return `${lines.join("\n")}\n`
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { encoding: "utf-8", cwd, stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function ensureGitIdentity(cwd: string): void {
  const has = (key: string): boolean => {
    try {
      git(["config", "--get", key], cwd)
      return true
    } catch {
      return false
    }
  }
  if (!has("user.email")) {
    try {
      git(["config", "user.email", "github-actions[bot]@users.noreply.github.com"], cwd)
    } catch {
      /* best-effort */
    }
  }
  if (!has("user.name")) {
    try {
      git(["config", "user.name", "github-actions[bot]"], cwd)
    } catch {
      /* best-effort */
    }
  }
}

function currentBranch(cwd: string): string | null {
  try {
    const ref = git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd)
    return ref || null
  } catch {
    return null
  }
}

export const healthCheckFlow: PreflightScript = async (ctx) => {
  ctx.skipAgent = true
  const { staleHours } = readHealthConfig(ctx)

  const rows = findActiveIssues(ctx.cwd)
  const report = formatHealthReport(rows, staleHours)

  const absPath = path.join(ctx.cwd, REPORT_PATH)
  fs.mkdirSync(path.dirname(absPath), { recursive: true })

  // Skip the commit when the rendered body is byte-identical to what's
  // already on disk — keeps the report's git history meaningful instead of
  // spamming a daily noop commit.
  let prior = ""
  try {
    prior = fs.readFileSync(absPath, "utf-8")
  } catch {
    /* missing → first run */
  }

  const stuckCount = rows.filter((r) => r.hoursStale >= staleHours).length
  process.stdout.write(`[health-check] active=${rows.length} stuck=${stuckCount} threshold=${staleHours}h\n`)

  if (prior === report) {
    process.stdout.write("[health-check] report unchanged — skipping commit\n")
    ctx.output.exitCode = 0
    ctx.data.activeCount = rows.length
    ctx.data.stuckCount = stuckCount
    return
  }

  fs.writeFileSync(absPath, report)

  const branch = currentBranch(ctx.cwd) ?? ctx.config.git.defaultBranch
  ensureGitIdentity(ctx.cwd)

  try {
    const result = commitAndPush(branch, COMMIT_MESSAGE, ctx.cwd)
    if (!result.committed) {
      process.stderr.write("[health-check] no commit produced (working tree clean after write?)\n")
    } else if (!result.pushed) {
      process.stderr.write(`[health-check] commit landed but push failed: ${result.pushError ?? "unknown"}\n`)
    } else {
      process.stdout.write(`[health-check] committed ${result.sha} to ${branch}\n`)
    }
  } catch (err) {
    process.stderr.write(
      `[health-check] commit/push failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }

  ctx.output.exitCode = 0
  ctx.data.activeCount = rows.length
  ctx.data.stuckCount = stuckCount
}
