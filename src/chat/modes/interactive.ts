/**
 * Interactive chat mode — long-lived runner that polls for new user messages
 * via the session JSONL inbox and runs a turn for each.
 *
 * Activated when the session file's first line is a meta line with
 * `mode: "interactive"`. Without that meta line, chat falls back to the
 * existing single-turn (one-shot) flow — no behavior change for legacy
 * sessions.
 *
 * Lifecycle events (consumed by the dashboard):
 *  - `chat.ready` — emitted once at boot. Dashboard unlocks the input.
 *  - `chat.message` / `chat.tool` / etc. — per-turn (same as one-shot).
 *  - `chat.exit`  — emitted on idle timeout, hard cap, or fatal error.
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { AgentResult } from "../../agent.js"
import type { ProviderModel } from "../../config.js"
import type { EventSink } from "../events.js"
import { eventsFilePath, makeRunId } from "../events.js"
import { waitForNextUserMessage } from "../inbox.js"
import type { ChatTurnResult } from "../loop.js"
import { runChatTurn } from "../loop.js"
import type { SessionMeta } from "../session.js"
import { readSession, sessionFilePath } from "../session.js"

const DEFAULT_IDLE_EXIT_MS = 5 * 60_000 // 5 minutes
const DEFAULT_HARD_CAP_MS = 30 * 60_000 // 30 minutes (spike cap; raise to 6h after validation)
const DEFAULT_POLL_MS = 30_000

export interface InteractiveModeOptions {
  sessionId: string
  cwd: string
  model: ProviderModel
  litellmUrl: string | null
  sink: EventSink
  meta: SessionMeta
  verbose?: boolean
  quiet?: boolean
  /** Test seam — bypasses real agent invocation. Threaded into runChatTurn. */
  invokeAgent?: (prompt: string) => Promise<AgentResult>
  /** Test seam — skip git pull, commit, push. Useful for in-process simulation. */
  skipGit?: boolean
  /** Test seam — override poll interval (default 30s). */
  pollIntervalMs?: number
}

export interface InteractiveModeResult {
  exitCode: number
  reason: "idle-timeout" | "deadline" | "fatal" | "ended"
  turnsCompleted: number
}

export async function runInteractiveMode(opts: InteractiveModeOptions): Promise<InteractiveModeResult> {
  const sessionFile = sessionFilePath(opts.cwd, opts.sessionId)
  const idleExitMs = opts.meta.idleExitMs ?? DEFAULT_IDLE_EXIT_MS
  const hardCapMs = opts.meta.hardCapMs ?? DEFAULT_HARD_CAP_MS
  const startedAt = Date.now()
  const deadlineMs = startedAt + hardCapMs

  process.stdout.write(`→ kody:chat:interactive: emitting chat.ready (idleExitMs=${idleExitMs}, hardCapMs=${hardCapMs})\n`)
  await emit(opts.sink, "chat.ready", opts.sessionId, "ready", {
    sessionId: opts.sessionId,
    startedAt: new Date(startedAt).toISOString(),
    idleExitMs,
    hardCapMs,
  })
  // Push the events file to origin RIGHT NOW so the dashboard's git-poll
  // sees chat.ready without waiting for the first turn. Without this, an
  // interactive session with no seed user message stays invisible until
  // the user sends — defeating the "warm up button → input enables" UX.
  if (!opts.skipGit) {
    process.stdout.write(`→ kody:chat:interactive: committing chat.ready event to git\n`)
    commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false)
    process.stdout.write(`→ kody:chat:interactive: chat.ready committed; entering poll loop\n`)
  }

  // Watermark = next index to look at. Start by replying to anything already
  // in the file (the dashboard typically seeds an initial user turn before
  // dispatch). After replying, we move past it and wait for new appends.
  let watermark = 0
  let turnsCompleted = 0

  while (true) {
    const turns = readSession(sessionFile)
    const pendingIdx = findNextUserTurn(turns, watermark)

    if (pendingIdx === -1) {
      const result = await waitForNextUserMessage({
        sessionFile,
        cwd: opts.cwd,
        watermark,
        idleTimeoutMs: idleExitMs,
        deadlineMs,
        pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_MS,
        skipPull: opts.skipGit,
      })
      if (result.kind === "idle-timeout") {
        await emitExit(opts, "idle-timeout", turnsCompleted)
        // Push the exit event so dashboards relying on the git-fallback
        // path see the lifecycle end (HttpSink delivers it real-time, but
        // a freshly-loading client needs the durable record too).
        if (!opts.skipGit) commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false)
        return { exitCode: 0, reason: "idle-timeout", turnsCompleted }
      }
      if (result.kind === "deadline") {
        await emitExit(opts, "deadline", turnsCompleted)
        if (!opts.skipGit) commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false)
        return { exitCode: 0, reason: "deadline", turnsCompleted }
      }
      // New message arrived — fall through and process it via runChatTurn,
      // which itself reads the session fresh.
    }

    let turnResult: ChatTurnResult
    try {
      turnResult = await runChatTurn({
        sessionId: opts.sessionId,
        sessionFile,
        cwd: opts.cwd,
        model: opts.model,
        litellmUrl: opts.litellmUrl,
        sink: opts.sink,
        verbose: opts.verbose,
        quiet: opts.quiet,
        invokeAgent: opts.invokeAgent,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await emit(opts.sink, "chat.error", opts.sessionId, `loop-${turnsCompleted}`, { error: msg })
      await emitExit(opts, "fatal", turnsCompleted)
      if (!opts.skipGit) commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false)
      return { exitCode: 99, reason: "fatal", turnsCompleted }
    }

    if (turnResult.exitCode === 64) {
      // "session empty" or "last turn already assistant" — treat as idle, keep polling.
      // This happens normally when the runner re-enters after replying.
    } else if (turnResult.exitCode !== 0) {
      // Non-fatal turn failures are emitted by runChatTurn via the sink. Don't
      // tear down the session — the user can retry.
    } else {
      turnsCompleted += 1
      if (!opts.skipGit) commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false)
    }

    // Advance watermark past everything we've seen, including the just-appended
    // assistant reply. Re-read because runChatTurn appends.
    watermark = readSession(sessionFile).length
  }
}

function findNextUserTurn(turns: ReturnType<typeof readSession>, fromIdx: number): number {
  for (let i = fromIdx; i < turns.length; i++) {
    if (turns[i]!.role === "user") return i
  }
  // If the trailing turn is `user`, runChatTurn will reply. Otherwise (last is
  // assistant or list empty from index), there's nothing pending.
  if (turns.length > 0 && turns[turns.length - 1]!.role === "user") return turns.length - 1
  return -1
}

function commitTurn(cwd: string, sessionId: string, verbose: boolean): void {
  const sessionRel = path.relative(cwd, sessionFilePath(cwd, sessionId))
  const eventsRel = path.relative(cwd, eventsFilePath(cwd, sessionId))
  const paths = [sessionRel, eventsRel].filter((p) => fs.existsSync(path.join(cwd, p)))
  if (paths.length === 0) return
  const stdio = verbose ? "inherit" : "pipe"
  try {
    // -f: same rationale as chat-cli's commitChatFiles — .kody/* may be
    // gitignored in consumer repos, but the dashboard's durable fallback
    // depends on these files reaching origin.
    execFileSync("git", ["add", "-f", ...paths], { cwd, stdio })
    execFileSync("git", ["commit", "--quiet", "-m", `chat: interactive turn for ${sessionId}`], { cwd, stdio })
    execFileSync("git", ["push", "--quiet", "origin", "HEAD"], { cwd, stdio })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody:chat:interactive] commit/push skipped: ${msg}\n`)
  }
}

async function emitExit(
  opts: InteractiveModeOptions,
  reason: InteractiveModeResult["reason"],
  turnsCompleted: number,
): Promise<void> {
  await emit(opts.sink, "chat.exit", opts.sessionId, "exit", {
    sessionId: opts.sessionId,
    reason,
    turnsCompleted,
    endedAt: new Date().toISOString(),
  })
}

async function emit(
  sink: EventSink,
  type: "chat.ready" | "chat.exit" | "chat.error",
  sessionId: string,
  suffix: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await sink.emit({
    event: type,
    payload,
    runId: makeRunId(sessionId, suffix),
    emittedAt: new Date().toISOString(),
  })
}
