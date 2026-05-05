/**
 * Container role tests.
 *
 * Containers are the in-process alternative to comment-based orchestrators.
 * The executor runs each declared child sequentially, reads the action type
 * the child wrote into state.core.lastOutcome, and routes via the child's
 * `next` map ("done" / "abort" / another child name).
 *
 * Children are mocked via the `__runChild` test seam — these tests never
 * spin up real executables. A matching `__readTaskState` stub feeds the
 * "what did the child just write" lookup.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import type { ExecutorInput, ExecutorOutput } from "../../src/executor.js"
import { runExecutable } from "../../src/executor.js"
import { loadProfile } from "../../src/profile.js"
import { type Action, emptyState, type TaskState, type TaskTarget } from "../../src/state.js"

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

/** Build a minimal container profile in a fresh project root. Returns the cwd. */
function makeContainerFixture(opts: {
  containerName: string
  children: Array<{ exec: string; target: "issue" | "pr"; next: Record<string, string> }>
}): string {
  const root = tmpDir("kody-container")
  const exeDir = path.join(root, ".kody", "executables", opts.containerName)
  fs.mkdirSync(exeDir, { recursive: true })
  const profile = {
    name: opts.containerName,
    role: "container",
    describe: "test container",
    kind: "oneshot",
    inputs: [
      {
        name: "issue",
        flag: "--issue",
        type: "int",
        required: true,
        describe: "Issue number to drive on.",
      },
    ],
    claudeCode: {
      model: "inherit",
      permissionMode: "default",
      maxTurns: 0,
      maxThinkingTokens: null,
      systemPromptAppend: null,
      tools: [],
      hooks: [],
      skills: [],
      commands: [],
      subagents: [],
      plugins: [],
      mcpServers: [],
    },
    cliTools: [],
    scripts: { preflight: [], postflight: [] },
    children: opts.children,
  }
  fs.writeFileSync(path.join(exeDir, "profile.json"), JSON.stringify(profile, null, 2))
  return root
}

/** Synthesize an Action of the given type. */
function action(type: string, payload: Record<string, unknown> = {}): Action {
  return { type, payload, timestamp: new Date().toISOString() }
}

/**
 * Build a __runChild + __readTaskState pair backed by a shared in-memory
 * TaskState. Each invocation script declares which child name to expect,
 * the action it should record, and any state mutations (e.g. setting prUrl).
 *
 * Returns helpers + the running state so tests can assert call order and
 * state at the end of the run.
 */
function makeMockEnvironment(
  scripts: Array<{
    exec: string
    onInvoke?: (state: TaskState) => Action
    exitCode?: number
  }>,
): {
  runChild: NonNullable<ExecutorInput["__runChild"]>
  readTaskState: NonNullable<ExecutorInput["__readTaskState"]>
  state: TaskState
  calls: Array<{ name: string; cliArgs: Record<string, unknown> }>
} {
  const state: TaskState = emptyState()
  const calls: Array<{ name: string; cliArgs: Record<string, unknown> }> = []

  const runChild: NonNullable<ExecutorInput["__runChild"]> = async (name, input): Promise<ExecutorOutput> => {
    calls.push({ name, cliArgs: input.cliArgs })
    const script = scripts.find((s) => s.exec === name)
    if (!script) {
      return { exitCode: 99, reason: `unexpected child invocation: ${name}` }
    }
    const a = script.onInvoke?.(state)
    if (a) {
      state.core.lastOutcome = a
      state.executables[name] = { lastAction: a }
      state.history.push({
        timestamp: a.timestamp,
        executable: name,
        action: a.type,
      })
    }
    return { exitCode: script.exitCode ?? 0 }
  }

  const readTaskState: NonNullable<ExecutorInput["__readTaskState"]> = (
    _target: TaskTarget,
    _num: number,
    _cwd?: string,
  ): TaskState => {
    // Return a deep-ish clone so callers can't mutate the canonical state.
    return JSON.parse(JSON.stringify(state)) as TaskState
  }

  return { runChild, readTaskState, state, calls }
}

describe("container: smoke fixture", () => {
  it("loads tests/fixtures/container-smoke/smoke-container without errors", () => {
    const profilePath = path.resolve(__dirname, "../fixtures/container-smoke/smoke-container/profile.json")
    const profile = loadProfile(profilePath)
    expect(profile.name).toBe("smoke-container")
    expect(profile.role).toBe("container")
    expect(profile.children).toHaveLength(2)
    expect(profile.children?.[0]?.exec).toBe("echo-a")
    expect(profile.children?.[0]?.next["ECHO_A_COMPLETED"]).toBe("echo-b")
    expect(profile.children?.[1]?.exec).toBe("echo-b")
    expect(profile.children?.[1]?.next["ECHO_B_COMPLETED"]).toBe("done")
  })
})

describe("container: profile loading", () => {
  it("loads a valid container profile with children", () => {
    const root = makeContainerFixture({
      containerName: "demo",
      children: [
        { exec: "plan", target: "issue", next: { PLAN_COMPLETED: "run", "*": "abort" } },
        { exec: "run", target: "issue", next: { RUN_COMPLETED: "done", "*": "abort" } },
      ],
    })
    const profile = loadProfile(path.join(root, ".kody", "executables", "demo", "profile.json"))
    expect(profile.role).toBe("container")
    expect(profile.children).toHaveLength(2)
    expect(profile.children?.[0]?.exec).toBe("plan")
    expect(profile.children?.[0]?.next.PLAN_COMPLETED).toBe("run")
  })

  it("rejects a container profile with no children", () => {
    const root = makeContainerFixture({ containerName: "demo", children: [] })
    expect(() => loadProfile(path.join(root, ".kody", "executables", "demo", "profile.json"))).toThrow(
      /role: "container" requires a non-empty "children" array/,
    )
  })

  it("rejects an invalid child target", () => {
    const root = makeContainerFixture({
      containerName: "demo",
      children: [{ exec: "plan", target: "bogus" as "issue", next: { "*": "done" } }],
    })
    expect(() => loadProfile(path.join(root, ".kody", "executables", "demo", "profile.json"))).toThrow(
      /target must be "issue" or "pr"/,
    )
  })

  it("rejects children on a non-container role", () => {
    const root = tmpDir("kody-container-bad-role")
    const exeDir = path.join(root, ".kody", "executables", "bad")
    fs.mkdirSync(exeDir, { recursive: true })
    const profile = {
      name: "bad",
      role: "primitive",
      describe: "",
      kind: "oneshot",
      inputs: [],
      claudeCode: {
        model: "inherit",
        permissionMode: "default",
        maxTurns: 0,
        maxThinkingTokens: null,
        systemPromptAppend: null,
        tools: [],
        hooks: [],
        skills: [],
        commands: [],
        subagents: [],
        plugins: [],
        mcpServers: [],
      },
      cliTools: [],
      scripts: { preflight: [], postflight: [] },
      children: [{ exec: "plan", target: "issue", next: { "*": "done" } }],
    }
    fs.writeFileSync(path.join(exeDir, "profile.json"), JSON.stringify(profile))
    expect(() => loadProfile(path.join(exeDir, "profile.json"))).toThrow(
      /"children" is only allowed when role === "container"/,
    )
  })
})

describe("container: routing through children", () => {
  it("routes PLAN_COMPLETED → run, then RUN_COMPLETED → done", async () => {
    const root = makeContainerFixture({
      containerName: "plan-run",
      children: [
        { exec: "plan", target: "issue", next: { PLAN_COMPLETED: "run", "*": "abort" } },
        { exec: "run", target: "issue", next: { RUN_COMPLETED: "done", "*": "abort" } },
      ],
    })
    const env = makeMockEnvironment([
      { exec: "plan", onInvoke: () => action("PLAN_COMPLETED") },
      { exec: "run", onInvoke: () => action("RUN_COMPLETED") },
    ])

    process.chdir(root)
    const result = await runExecutable("plan-run", {
      cliArgs: { issue: 42 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(0)
    expect(env.calls.map((c) => c.name)).toEqual(["plan", "run"])
    expect(env.calls[0]?.cliArgs).toEqual({ issue: 42 })
  })

  it("aborts when a child action maps to 'abort'", async () => {
    const root = makeContainerFixture({
      containerName: "plan-abort",
      children: [
        {
          exec: "plan",
          target: "issue",
          next: { PLAN_COMPLETED: "run", PLAN_FAILED: "abort", "*": "abort" },
        },
        { exec: "run", target: "issue", next: { RUN_COMPLETED: "done", "*": "abort" } },
      ],
    })
    const env = makeMockEnvironment([
      { exec: "plan", onInvoke: () => action("PLAN_FAILED") },
      { exec: "run", onInvoke: () => action("RUN_COMPLETED") },
    ])

    process.chdir(root)
    const result = await runExecutable("plan-abort", {
      cliArgs: { issue: 42 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(1)
    expect(env.calls.map((c) => c.name)).toEqual(["plan"]) // run never reached
    expect(result.reason).toMatch(/aborted by route/)
  })

  it("aborts when an action type has no route and no wildcard", async () => {
    const root = makeContainerFixture({
      containerName: "no-route",
      children: [{ exec: "plan", target: "issue", next: { PLAN_COMPLETED: "done" } }],
    })
    const env = makeMockEnvironment([{ exec: "plan", onInvoke: () => action("PLAN_FAILED") }])

    process.chdir(root)
    const result = await runExecutable("no-route", {
      cliArgs: { issue: 1 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(1)
    expect(result.reason).toMatch(/no route for action "PLAN_FAILED"/)
  })
})

describe("container: idempotency", () => {
  it("skips a child whose lastAction already ends in _COMPLETED", async () => {
    const root = makeContainerFixture({
      containerName: "resume",
      children: [
        { exec: "plan", target: "issue", next: { PLAN_COMPLETED: "run", "*": "abort" } },
        { exec: "run", target: "issue", next: { RUN_COMPLETED: "done", "*": "abort" } },
      ],
    })
    const env = makeMockEnvironment([
      // plan should NOT be invoked — pre-seeded as completed.
      { exec: "plan", onInvoke: () => action("PLAN_COMPLETED") },
      { exec: "run", onInvoke: () => action("RUN_COMPLETED") },
    ])
    // Pre-seed plan as already completed.
    const seeded = action("PLAN_COMPLETED")
    env.state.executables.plan = { lastAction: seeded }
    env.state.core.lastOutcome = seeded

    process.chdir(root)
    const result = await runExecutable("resume", {
      cliArgs: { issue: 7 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(0)
    // Only run was invoked; plan's prior outcome routed us straight to run.
    expect(env.calls.map((c) => c.name)).toEqual(["run"])
  })
})

describe("container: PR target resolution", () => {
  it("aborts with AGENT_NOT_RUN when target=pr but state.core.prUrl is unset", async () => {
    const root = makeContainerFixture({
      containerName: "pr-target",
      children: [
        { exec: "plan", target: "issue", next: { PLAN_COMPLETED: "review", "*": "abort" } },
        { exec: "review", target: "pr", next: { REVIEW_PASS: "done", "*": "abort" } },
      ],
    })
    const env = makeMockEnvironment([
      { exec: "plan", onInvoke: () => action("PLAN_COMPLETED") },
      { exec: "review", onInvoke: () => action("REVIEW_PASS") },
    ])

    process.chdir(root)
    const result = await runExecutable("pr-target", {
      cliArgs: { issue: 99 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(1)
    expect(result.reason).toMatch(/needs --pr but state\.core\.prUrl is unset/)
    expect(env.calls.map((c) => c.name)).toEqual(["plan"]) // review never reached
  })

  it("passes --pr to the child when state.core.prUrl is parseable", async () => {
    const root = makeContainerFixture({
      containerName: "pr-ok",
      children: [
        {
          exec: "plan",
          target: "issue",
          next: { PLAN_COMPLETED: "review", "*": "abort" },
        },
        { exec: "review", target: "pr", next: { REVIEW_PASS: "done", "*": "abort" } },
      ],
    })
    const env = makeMockEnvironment([
      {
        exec: "plan",
        onInvoke: (state) => {
          state.core.prUrl = "https://github.com/o/r/pull/123"
          return action("PLAN_COMPLETED")
        },
      },
      { exec: "review", onInvoke: () => action("REVIEW_PASS") },
    ])

    process.chdir(root)
    const result = await runExecutable("pr-ok", {
      cliArgs: { issue: 7 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(0)
    expect(env.calls).toHaveLength(2)
    expect(env.calls[0]?.cliArgs).toEqual({ issue: 7 })
    expect(env.calls[1]?.cliArgs).toEqual({ pr: 123 })
  })
})

describe("container: iteration cap", () => {
  it("aborts after 50 iterations on a routing loop", async () => {
    const root = makeContainerFixture({
      containerName: "loop",
      children: [
        { exec: "a", target: "issue", next: { TICK: "b", "*": "abort" } },
        { exec: "b", target: "issue", next: { TICK: "a", "*": "abort" } },
      ],
    })
    const env = makeMockEnvironment([
      { exec: "a", onInvoke: () => action("TICK") },
      { exec: "b", onInvoke: () => action("TICK") },
    ])

    process.chdir(root)
    const result = await runExecutable("loop", {
      cliArgs: { issue: 1 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(1)
    expect(result.reason).toMatch(/exceeded 50 iterations/)
  }, 10_000)
})
