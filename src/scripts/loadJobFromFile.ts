/**
 * Preflight: load a file-based job (body from disk, state via the
 * configured `JobStateBackend`) into ctx.data. Mirror of
 * `loadIssueStateComment` for the file-based job model.
 *
 * Reads the markdown body at `<jobsDir>/<slug>.md` and the job's
 * state via `resolveBackend(config, cwd, jobsDir).load(slug)`. Sets:
 *
 *   ctx.data.jobSlug         the slug
 *   ctx.data.jobTitle        first H1 of the body, or slug formatted
 *   ctx.data.jobIntent       the body (post-frontmatter, if any)
 *   ctx.data.jobStateJson    rendered prior state, or seed on first run
 *   ctx.data.jobState        LoadedJobState (path, handle, state, created)
 *
 * Script args (via `with:`):
 *   jobsDir   optional — default ".kody/jobs"
 *   slugArg       optional — name of the CLI input holding the slug (default "job")
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"
import { resolveBackend } from "./jobState/index.js"

export const loadJobFromFile: PreflightScript = async (ctx, _profile, args) => {
  const jobsDir = String(args?.jobsDir ?? ".kody/jobs")
  const slugArg = String(args?.slugArg ?? "job")
  const slug = String(ctx.args[slugArg] ?? "").trim()
  if (!slug) {
    throw new Error(`loadJobFromFile: ctx.args.${slugArg} must be a non-empty slug`)
  }

  const absPath = path.join(ctx.cwd, jobsDir, `${slug}.md`)
  if (!fs.existsSync(absPath)) {
    throw new Error(`loadJobFromFile: job file not found: ${absPath}`)
  }
  const raw = fs.readFileSync(absPath, "utf-8")
  const { title, body } = parseJobFile(raw, slug)

  // Backend-agnostic load. Returns a seed envelope on first run.
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  const loaded = await backend.load(slug)

  ctx.data.jobSlug = slug
  ctx.data.jobTitle = title
  ctx.data.jobIntent = body
  ctx.data.jobState = loaded
  ctx.data.jobStateJson = JSON.stringify(loaded.state, null, 2)
}

interface ParsedJob {
  title: string
  body: string
}

function parseJobFile(raw: string, slug: string): ParsedJob {
  // Strip optional YAML frontmatter (`---\n...\n---\n`) — reserved for future
  // use (e.g. cadence overrides); ignored at load time.
  let stripped = raw
  if (stripped.startsWith("---\n")) {
    const end = stripped.indexOf("\n---\n", 4)
    if (end !== -1) {
      stripped = stripped.slice(end + 5)
    }
  }
  const trimmed = stripped.trim()
  const firstLine = trimmed.split("\n", 1)[0] ?? ""
  const h1 = /^#\s+(.+?)\s*$/.exec(firstLine)
  if (h1) {
    const rest = trimmed.slice(firstLine.length).replace(/^\n+/, "")
    return { title: h1[1]!.trim(), body: rest }
  }
  return { title: humanizeSlug(slug), body: trimmed }
}

function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter((s) => s.length > 0)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join(" ")
}
