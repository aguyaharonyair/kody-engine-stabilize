/**
 * Tiny YAML-frontmatter parser/serializer for job files.
 *
 * Job markdown at `.kody/jobs/<slug>.md` may begin with a `---\n…\n---\n`
 * block carrying flat scalar key/value pairs (no nesting, no flow style).
 * Today the only recognized field is `every: 15m|30m|1h|6h|1d`, which
 * gates per-slug cadence in `dispatchJobFileTicks`. The parser silently
 * ignores unknown keys so the dashboard and engine can evolve the
 * frontmatter independently.
 *
 * Mirror of `src/dashboard/lib/jobs-frontmatter.ts` in Kody-Dashboard —
 * keep the two in sync if the format grows.
 */

export type ScheduleEvery = "15m" | "30m" | "1h" | "6h" | "1d"

const SCHEDULE_EVERY_VALUES: readonly ScheduleEvery[] = ["15m", "30m", "1h", "6h", "1d"] as const

export interface JobFrontmatter {
  every?: ScheduleEvery
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function splitFrontmatter(raw: string): {
  frontmatter: JobFrontmatter
  body: string
} {
  const match = FRONTMATTER_RE.exec(raw)
  if (!match) return { frontmatter: {}, body: raw }
  const inner = match[1] ?? ""
  const body = raw.slice(match[0].length)
  return { frontmatter: parseFlatYaml(inner), body }
}

export function isScheduleEvery(value: unknown): value is ScheduleEvery {
  return typeof value === "string" && (SCHEDULE_EVERY_VALUES as readonly string[]).includes(value)
}

export function scheduleEveryToMs(every: ScheduleEvery): number {
  switch (every) {
    case "15m":
      return 15 * 60 * 1000
    case "30m":
      return 30 * 60 * 1000
    case "1h":
      return 60 * 60 * 1000
    case "6h":
      return 6 * 60 * 60 * 1000
    case "1d":
      return 24 * 60 * 60 * 1000
  }
}

function parseFlatYaml(text: string): JobFrontmatter {
  const out: JobFrontmatter = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    const value = stripQuotes(line.slice(colon + 1).trim())
    if (key === "every" && isScheduleEvery(value)) {
      out.every = value
    }
  }
  return out
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}
