import { describe, expect, it } from "vitest"
import { deriveBranchName, UncommittedChangesError } from "../../src/branch.js"
import { resolveBaseFromLabels, resolveBaseOverride } from "../../src/scripts/runFlow.js"

describe("branch: deriveBranchName", () => {
  it("slugifies title with issue number prefix", () => {
    expect(deriveBranchName(42, "Add feature X")).toBe("42-add-feature-x")
  })

  it("strips special characters", () => {
    expect(deriveBranchName(7, "Fix: bug! (urgent)")).toBe("7-fix-bug-urgent")
  })

  it("collapses repeated dashes", () => {
    expect(deriveBranchName(1, "a   b---c")).toBe("1-a-b-c")
  })

  it("trims trailing dash", () => {
    expect(deriveBranchName(1, "feature-")).toBe("1-feature")
  })

  it("caps slug length to 50 chars", () => {
    const long = "a".repeat(80)
    const result = deriveBranchName(1, long)
    expect(result.length).toBeLessThanOrEqual(53)
    expect(result.startsWith("1-")).toBe(true)
  })

  it("handles empty title", () => {
    expect(deriveBranchName(99, "")).toBe("99")
  })

  it("handles title that produces empty slug", () => {
    expect(deriveBranchName(99, "!!!")).toBe("99")
  })
})

describe("branch: UncommittedChangesError", () => {
  it("includes branch name in message", () => {
    const err = new UncommittedChangesError("feat-branch")
    expect(err.message).toMatch(/feat-branch/)
    expect(err.name).toBe("UncommittedChangesError")
    expect(err.branch).toBe("feat-branch")
  })
})

describe("runFlow: resolveBaseOverride", () => {
  // The --base override is the only way a comment can redirect kody onto a
  // non-default branch. We allowlist the goal-branch convention specifically
  // so the comment surface can't be abused to push to an arbitrary branch.
  it("accepts a well-formed goal branch", () => {
    expect(resolveBaseOverride("goal-add-chat-memory")).toBe("goal-add-chat-memory")
    expect(resolveBaseOverride("goal-x")).toBe("goal-x")
    expect(resolveBaseOverride("goal-1234")).toBe("goal-1234")
  })

  it("rejects empty / undefined", () => {
    expect(resolveBaseOverride(undefined)).toBeNull()
    expect(resolveBaseOverride("")).toBeNull()
  })

  it("rejects non-goal branches", () => {
    expect(resolveBaseOverride("main")).toBeNull()
    expect(resolveBaseOverride("feat/foo")).toBeNull()
    expect(resolveBaseOverride("release-1.2")).toBeNull()
  })

  it("rejects values with disallowed characters", () => {
    expect(resolveBaseOverride("goal-Bad")).toBeNull() // uppercase
    expect(resolveBaseOverride("goal-foo/bar")).toBeNull() // slash
    expect(resolveBaseOverride("goal-foo bar")).toBeNull() // space
    expect(resolveBaseOverride("goal-")).toBeNull() // trailing dash with empty slug
  })
})

describe("runFlow: resolveBaseFromLabels", () => {
  // Labels are the durable signal because they survive the classify →
  // bug/feature/chore container hop that strips comment-supplied flags.
  // Both labels must be present: `goal-runner:dispatched` confirms the
  // autonomous driver started this run, and `goal:<id>` names the branch.
  it("returns goal-<id> when both labels present", () => {
    expect(resolveBaseFromLabels(["goal-runner:dispatched", "goal:test-greet-chain"])).toBe("goal-test-greet-chain")
  })

  it("returns null when goal-runner:dispatched is missing", () => {
    expect(resolveBaseFromLabels(["goal:test-greet-chain"])).toBeNull()
  })

  it("returns null when goal:<id> is missing", () => {
    expect(resolveBaseFromLabels(["goal-runner:dispatched"])).toBeNull()
  })

  it("returns null when labels array is empty", () => {
    expect(resolveBaseFromLabels([])).toBeNull()
  })

  it("rejects malformed goal ids (uppercase / spaces / slashes)", () => {
    expect(resolveBaseFromLabels(["goal-runner:dispatched", "goal:Bad"])).toBeNull()
    expect(resolveBaseFromLabels(["goal-runner:dispatched", "goal:foo/bar"])).toBeNull()
    expect(resolveBaseFromLabels(["goal-runner:dispatched", "goal:foo bar"])).toBeNull()
    expect(resolveBaseFromLabels(["goal-runner:dispatched", "goal:"])).toBeNull()
  })

  it("ignores other labels", () => {
    expect(resolveBaseFromLabels(["bug", "goal-runner:dispatched", "kody:running", "goal:abc-123"])).toBe(
      "goal-abc-123",
    )
  })
})
