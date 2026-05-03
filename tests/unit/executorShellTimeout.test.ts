/**
 * Verifies executor.runShellEntry timeout handling:
 *   - per-entry `timeoutSec` is honored
 *   - timeout produces exit 124 with an explicit "timed out" reason
 *     (distinct from a script's own non-zero exit, which historically
 *     surfaced as "exited -1")
 *   - KODY_SHELL_TIMEOUT_SEC env var is honored when no entry override
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runExecutable } from "../../src/executor.js"

function makeFixture(opts: {
  exeName: string
  timeoutSec?: number
  sleepSec: number
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-shell-timeout-"))
  const exeDir = path.join(root, ".kody", "executables", opts.exeName)
  fs.mkdirSync(exeDir, { recursive: true })
  fs.writeFileSync(
    path.join(exeDir, "slow.sh"),
    `#!/usr/bin/env bash\nsleep ${opts.sleepSec}\necho "should not reach here"\n`,
    { mode: 0o755 },
  )
  const shellEntry: Record<string, unknown> = { shell: "slow.sh" }
  if (opts.timeoutSec !== undefined) shellEntry.timeoutSec = opts.timeoutSec
  const profile = {
    name: opts.exeName,
    role: "utility",
    describe: "fixture",
    kind: "oneshot",
    inputs: [],
    claudeCode: {
      model: "inherit",
      permissionMode: "acceptEdits",
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
    scripts: {
      preflight: [{ script: "skipAgent" }, shellEntry],
      postflight: [],
    },
  }
  fs.writeFileSync(path.join(exeDir, "profile.json"), JSON.stringify(profile, null, 2))
  return root
}

describe("executor: shell entry timeout", () => {
  let savedCwd: string
  let savedEnv: string | undefined

  beforeEach(() => {
    savedCwd = process.cwd()
    savedEnv = process.env.KODY_SHELL_TIMEOUT_SEC
  })

  afterEach(() => {
    process.chdir(savedCwd)
    if (savedEnv === undefined) delete process.env.KODY_SHELL_TIMEOUT_SEC
    else process.env.KODY_SHELL_TIMEOUT_SEC = savedEnv
  })

  it("times out with exit 124 and explicit reason when entry timeoutSec is exceeded", async () => {
    const root = makeFixture({ exeName: "timeout-fixture-a", timeoutSec: 1, sleepSec: 5 })
    process.chdir(root)
    const result = await runExecutable("timeout-fixture-a", {
      cliArgs: {},
      cwd: root,
      skipConfig: true,
    })
    expect(result.exitCode).toBe(124)
    expect(result.reason).toMatch(/timed out after 1s/)
    expect(result.reason).not.toMatch(/exited -1/)
  }, 10_000)

  it("respects KODY_SHELL_TIMEOUT_SEC env var when entry has no override", async () => {
    const root = makeFixture({ exeName: "timeout-fixture-b", sleepSec: 5 })
    process.chdir(root)
    process.env.KODY_SHELL_TIMEOUT_SEC = "1"
    const result = await runExecutable("timeout-fixture-b", {
      cliArgs: {},
      cwd: root,
      skipConfig: true,
    })
    expect(result.exitCode).toBe(124)
    expect(result.reason).toMatch(/timed out after 1s/)
  }, 10_000)
})
