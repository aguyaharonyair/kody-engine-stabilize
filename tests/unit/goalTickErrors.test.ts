/**
 * Repro for issue #2: goal-tick tick.sh errors are swallowed by 2>/dev/null.
 *
 * Bug: tick.sh uses `2>/dev/null` on gh calls, so when gh fails the actual
 * error message is not visible in CI logs. The "continuing without ..."
 * messages say nothing about WHY the gh call failed.
 *
 * Expected: when a gh command fails, the error message should be captured
 * and logged so failures are diagnosable.
 *
 * Also: tick.sh should emit one structured phase line per tick like:
 *   [goal-tick] phase=<phase> in_flight=<n> last_action=<name>
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runExecutable } from "../../src/executor.js"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-goal-tick-errors-"))
}

// A mock gh that always succeeds - for phase logging tests
function makeSuccinctMockGh(): string {
  return `#!/usr/bin/env bash
cmd="$1"
shift
args="$*"

case "$cmd" in
  api)
    if [[ "$args" == *"repos/{owner}/{repo}"* ]] && [[ "$args" == *"default_branch"* ]]; then
      echo '"main"'
    else
      echo '[]'
    fi
    ;;
  issue)
    if [[ "$args" == "create"* ]]; then
      echo "https://github.com/owner/repo/issues/123"
    else
      echo '[]'
    fi
    ;;
  pr)
    if [[ "$args" == "create"* ]]; then
      echo "https://github.com/owner/repo/pull/1"
    else
      echo '[]'
    fi
    ;;
  label)
    echo "mocked"
    ;;
  auth)
    echo "✓"
    ;;
  *)
    echo "ok"
    ;;
esac
exit 0
`
}

// A mock gh that fails on a specific command, outputting error to stderr
function makeFailingMockGh(failingPattern: string, errorMsg: string): string {
  // The failingPattern can be: "issue create" or "repos/{owner}/{repo}"
  // Map to specific command checks
  const isIssueCreate = failingPattern.includes("issue") && failingPattern.includes("create")
  const isApiCall = failingPattern.includes("repos/{owner}/{repo}")

  let failCheck = ""
  if (isIssueCreate) {
    failCheck = `if [[ "\$cmd" == "issue" ]] && [[ "\$args" == "create"* ]]; then
  echo "${errorMsg}" >&2
  exit 1
fi`
  } else if (isApiCall) {
    failCheck = `if [[ "\$cmd" == "api" ]] && [[ "\$args" == *"repos/"* ]]; then
  echo "${errorMsg}" >&2
  exit 1
fi`
  }

  return `#!/usr/bin/env bash
cmd="$1"
shift
args="$*"

# Fail only on the specific failing command pattern
${failCheck}

# Otherwise succeed
case "$cmd" in
  api)
    if [[ "\$args" == *"repos/{owner}/{repo}"* ]] && [[ "\$args" == *"default_branch"* ]]; then
      echo '"main"'
    else
      echo '[]'
    fi
    ;;
  issue)
    if [[ "\$args" == "create"* ]]; then
      echo "https://github.com/owner/repo/issues/123"
    else
      echo '[]'
    fi
    ;;
  pr)
    if [[ "\$args" == "create"* ]]; then
      echo "https://github.com/owner/repo/pull/1"
    else
      echo '[]'
    fi
    ;;
  label)
    echo "mocked"
    ;;
  auth)
    echo "✓"
    ;;
  *)
    echo "ok"
    ;;
esac
exit 0
`
}

function createGoalTickExecutable(root: string, exeName: string, mockGh: string): void {
  const exeDir = path.join(root, ".kody", "executables", exeName)
  fs.mkdirSync(exeDir, { recursive: true })

  const ghPath = path.join(exeDir, "gh")
  fs.writeFileSync(ghPath, mockGh, { mode: 0o755 })

  const realTickSh = fs.readFileSync(path.join(__dirname, "../../src/executables/goal-tick/tick.sh"), "utf8")
  const modifiedTickSh = `export PATH="${exeDir}:$PATH"\n${realTickSh}`
  fs.writeFileSync(path.join(exeDir, "tick.sh"), modifiedTickSh, { mode: 0o755 })

  const profile = {
    name: exeName,
    role: "primitive",
    describe: "test fixture",
    kind: "oneshot",
    inputs: [{ name: "goal", flag: "--goal", type: "string", required: true, describe: "" }],
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
    cliTools: [
      {
        name: "gh",
        install: { required: true, checkCommand: "command -v gh" },
        verify: "gh auth status",
        usage: "gh CLI",
        allowedUses: ["issue", "pr", "api"],
      },
    ],
    scripts: {
      preflight: [{ script: "skipAgent" }, { shell: "tick.sh" }],
      postflight: [],
    },
  }
  fs.writeFileSync(path.join(exeDir, "profile.json"), JSON.stringify(profile, null, 2))
}

function createGoalState(root: string, goalId: string, state: Record<string, unknown>): void {
  const goalDir = path.join(root, ".kody", "goals", goalId)
  fs.mkdirSync(goalDir, { recursive: true })
  fs.writeFileSync(path.join(goalDir, "state.json"), JSON.stringify(state, null, 2))
}

describe("goal-tick: gh errors must be surfaced", () => {
  let savedCwd: string
  let stdoutData: string[] = []
  let stderrData: string[] = []

  beforeEach(() => {
    savedCwd = process.cwd()
    stdoutData = []
    stderrData = []

    const origOut = process.stdout.write.bind(process.stdout)
    const origErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = (chunk: string | Uint8Array) => {
      stdoutData.push(String(chunk))
      return origOut(chunk)
    }
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrData.push(String(chunk))
      return origErr(chunk)
    }
  })

  afterEach(() => {
    process.chdir(savedCwd)
    process.stdout.write = process.stdout.write.bind(process.stdout)
    process.stderr.write = process.stderr.write.bind(process.stderr)
  })

  function combinedOutput(): string {
    return [...stdoutData, ...stderrData].join("")
  }

  it("surfaces gh issue create error message (currently suppressed by 2>/dev/null)", async () => {
    const root = tmpDir()
    const errorMsg = "GraphQL: Resource not accessible (createIssue)"
    // tick.sh calls: gh issue create --title ... --body ... --label ...
    createGoalTickExecutable(root, "goal-tick-issue-err", makeFailingMockGh("issue create", errorMsg))
    createGoalState(root, "test-goal", { state: "active" })

    process.chdir(root)
    await runExecutable("goal-tick-issue-err", {
      cliArgs: { goal: "test-goal" },
      cwd: root,
      skipConfig: true,
    })

    // BUG: tick.sh uses `2>/dev/null` on gh issue create, so the error is NOT visible
    // After fix: error message should appear in output
    expect(combinedOutput()).toContain(errorMsg)
  })

  it("surfaces gh api error message (currently suppressed by 2>/dev/null)", async () => {
    const root = tmpDir()
    const errorMsg = "API call rate limit exceeded"
    // tick.sh calls: gh api repos/{owner}/{repo} --jq .default_branch
    createGoalTickExecutable(root, "goal-tick-api-err", makeFailingMockGh("repos/{owner}/{repo}", errorMsg))
    createGoalState(root, "test-goal", { state: "active" })

    process.chdir(root)
    await runExecutable("goal-tick-api-err", {
      cliArgs: { goal: "test-goal" },
      cwd: root,
      skipConfig: true,
    })

    // BUG: tick.sh uses `2>/dev/null` on gh api default_branch lookup
    expect(combinedOutput()).toContain(errorMsg)
  })
})

describe("goal-tick: structured phase logging", () => {
  let savedCwd: string
  let stdoutData: string[] = []

  beforeEach(() => {
    savedCwd = process.cwd()
    stdoutData = []

    const origOut = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array) => {
      stdoutData.push(String(chunk))
      return origOut(chunk)
    }
  })

  afterEach(() => {
    process.chdir(savedCwd)
    process.stdout.write = process.stdout.write.bind(process.stdout)
  })

  it("emits structured phase line per tick (currently missing)", async () => {
    const root = tmpDir()
    createGoalTickExecutable(root, "goal-tick-phase", makeSuccinctMockGh())
    createGoalState(root, "test-goal", { state: "active" })

    process.chdir(root)
    await runExecutable("goal-tick-phase", {
      cliArgs: { goal: "test-goal" },
      cwd: root,
      skipConfig: true,
    })

    const output = stdoutData.join("")
    // After fix: each tick should emit a structured phase line like:
    //   [goal-tick] phase=<phase> in_flight=<n> last_action=<name>
    // All three fields appear on a single line, so we use .* to match any content between [goal-tick] and each field
    expect(output).toMatch(/\[goal-tick\] phase=\w+/)
    expect(output).toMatch(/\[goal-tick\].*in_flight=\d+/)
    expect(output).toMatch(/\[goal-tick\].*last_action=\w+/)
  })
})
