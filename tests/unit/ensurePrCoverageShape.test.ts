/**
 * Verifies ensurePr's coverage-miss extraction is defensive against shape
 * drift. The historical strict read of `m.expectedTest` produced
 * "undefined, undefined" silently when an entry's shape was different;
 * this lets ensurePr open a non-draft PR despite real test gaps.
 *
 * collectExpectedTests now accepts `expectedTest`, `expected`, or `file`
 * fields (priority order) and warns when entries are unparseable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { collectExpectedTests } from "../../src/scripts/ensurePr.js"

describe("ensurePr: collectExpectedTests", () => {
  let stderrMock: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrMock = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    stderrMock.mockRestore()
  })

  it("returns [] for empty / non-array input", () => {
    expect(collectExpectedTests(undefined)).toEqual([])
    expect(collectExpectedTests(null)).toEqual([])
    expect(collectExpectedTests([])).toEqual([])
    expect(collectExpectedTests("not-an-array")).toEqual([])
  })

  it("extracts expectedTest field (canonical shape)", () => {
    const out = collectExpectedTests([
      { expectedTest: "src/foo.test.ts" },
      { expectedTest: "src/bar.test.ts" },
    ])
    expect(out).toEqual(["src/foo.test.ts", "src/bar.test.ts"])
    expect(stderrMock).not.toHaveBeenCalled()
  })

  it("falls back to expected/file when expectedTest is missing", () => {
    const out = collectExpectedTests([
      { expected: "src/a.test.ts" },
      { file: "src/b.test.ts" },
    ])
    expect(out).toEqual(["src/a.test.ts", "src/b.test.ts"])
  })

  it("warns when entries are unparseable", () => {
    const out = collectExpectedTests([
      { expectedTest: "src/ok.test.ts" },
      { somethingElse: "value" },
      null,
      "string-not-object",
    ])
    expect(out).toEqual(["src/ok.test.ts"])
    expect(stderrMock).toHaveBeenCalledOnce()
    const arg = stderrMock.mock.calls[0]![0] as string
    expect(arg).toContain("3 coverageMisses entry")
    expect(arg).toContain("shape may have drifted")
  })

  it("does not warn when all entries are parseable", () => {
    const out = collectExpectedTests([{ expectedTest: "x.test.ts" }])
    expect(out).toEqual(["x.test.ts"])
    expect(stderrMock).not.toHaveBeenCalled()
  })
})
