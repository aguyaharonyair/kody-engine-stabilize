import { describe, expect, it } from "vitest"
import { computeFailureSuffix } from "../../src/scripts/postIssueComment.js"

describe("postIssueComment.computeFailureSuffix", () => {
  it("returns ' — draft PR: <url>' when a brand-new PR was created", () => {
    expect(
      computeFailureSuffix({
        prUrl: "https://github.com/o/r/pull/1",
        prAction: "created",
        branch: "kody/x",
        branchPushed: true,
        githubOwner: "o",
        githubRepo: "r",
      }),
    ).toBe(" — draft PR: https://github.com/o/r/pull/1")
  })

  it("returns ' — PR: <url>' when an existing PR was updated", () => {
    expect(
      computeFailureSuffix({
        prUrl: "https://github.com/o/r/pull/1",
        prAction: "updated",
        branch: "kody/x",
        branchPushed: true,
        githubOwner: "o",
        githubRepo: "r",
      }),
    ).toBe(" — PR: https://github.com/o/r/pull/1")
  })

  it("returns a branch URL when ensurePr was gated but the branch was pushed", () => {
    expect(
      computeFailureSuffix({
        prUrl: undefined,
        prAction: undefined,
        branch: "kody/x",
        branchPushed: true,
        githubOwner: "o",
        githubRepo: "r",
      }),
    ).toBe(" — branch: https://github.com/o/r/tree/kody/x")
  })

  it("returns empty when nothing was pushed (no PR, no branch to inspect)", () => {
    expect(
      computeFailureSuffix({
        prUrl: undefined,
        prAction: undefined,
        branch: "kody/x",
        branchPushed: false,
        githubOwner: "o",
        githubRepo: "r",
      }),
    ).toBe("")
  })

  it("returns empty when the branch is unknown even if a commit was reported", () => {
    expect(
      computeFailureSuffix({
        prUrl: undefined,
        prAction: undefined,
        branch: undefined,
        branchPushed: true,
        githubOwner: "o",
        githubRepo: "r",
      }),
    ).toBe("")
  })

  it("returns empty when github owner/repo are missing", () => {
    expect(
      computeFailureSuffix({
        prUrl: undefined,
        prAction: undefined,
        branch: "kody/x",
        branchPushed: true,
        githubOwner: undefined,
        githubRepo: "r",
      }),
    ).toBe("")
  })
})
