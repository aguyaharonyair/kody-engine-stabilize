/**
 * Unit tests for ContentsApiBackend. The `gh` CLI shim is mocked; these
 * tests assert the API call payloads and the load/save/no-op semantics.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { gh as ghMock } from "../../src/issue.js"
import type { StateEnvelope } from "../../src/scripts/issueStateComment.js"
import { ContentsApiBackend } from "../../src/scripts/jobState/contentsApiBackend.js"

const gh = ghMock as unknown as ReturnType<typeof vi.fn>

function envelope(overrides: Partial<StateEnvelope> = {}): StateEnvelope {
  return {
    version: 1,
    rev: 1,
    cursor: "tick-1",
    data: { foo: "bar" },
    done: false,
    ...overrides,
  }
}

function backend() {
  return new ContentsApiBackend({
    owner: "acme",
    repo: "widgets",
    jobsDir: ".kody/jobs",
    cwd: "/tmp/repo",
  })
}

describe("ContentsApiBackend", () => {
  beforeEach(() => {
    gh.mockReset()
  })

  describe("constructor", () => {
    it("requires owner and repo", () => {
      expect(() => new ContentsApiBackend({ owner: "", repo: "r", jobsDir: "x" })).toThrow(/owner.*required/i)
      expect(() => new ContentsApiBackend({ owner: "o", repo: "", jobsDir: "x" })).toThrow(/repo.*required/i)
    })
  })

  describe("load", () => {
    it("returns a seed envelope when the file does not exist (404)", () => {
      gh.mockImplementationOnce(() => {
        throw new Error("HTTP 404: Not Found")
      })

      const out = backend().load("auto-sync")

      expect(out.created).toBe(true)
      expect(out.handle).toBeNull()
      expect(out.state.rev).toBe(0)
      expect(out.state.cursor).toBe("seed")
      expect(out.path).toBe(".kody/jobs/auto-sync.state.json")
    })

    it("decodes a base64 contents response into a LoadedJobState", () => {
      const state = envelope({ rev: 5, cursor: "tick-5" })
      const body = JSON.stringify(state)
      gh.mockReturnValueOnce(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from(body, "utf-8").toString("base64"),
          sha: "abc123",
          path: ".kody/jobs/auto-sync.state.json",
        }),
      )

      const out = backend().load("auto-sync")

      expect(out.created).toBe(false)
      expect(out.handle).toBe("abc123")
      expect(out.state).toEqual(state)
    })

    it("rethrows non-404 gh errors", () => {
      gh.mockImplementationOnce(() => {
        throw new Error("HTTP 500: Internal Server Error")
      })
      expect(() => backend().load("auto-sync")).toThrow(/500/)
    })

    it("rejects non-JSON contents responses", () => {
      gh.mockReturnValueOnce("not json")
      expect(() => backend().load("auto-sync")).toThrow(/did not return JSON/i)
    })

    it("rejects non-StateEnvelope payloads", () => {
      gh.mockReturnValueOnce(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify({ not: "envelope" }), "utf-8").toString("base64"),
          sha: "abc",
          path: ".kody/jobs/auto-sync.state.json",
        }),
      )
      expect(() => backend().load("auto-sync")).toThrow(/not a StateEnvelope/i)
    })
  })

  describe("save", () => {
    it("PUTs without sha when seeding (handle null)", () => {
      gh.mockReturnValueOnce("{}")
      const next = envelope({ rev: 1 })
      const wrote = backend().save(
        { path: ".kody/jobs/auto-sync.state.json", handle: null, state: envelope({ rev: 0 }), created: true },
        next,
      )
      expect(wrote).toBe(true)
      const call = gh.mock.calls[0]!
      expect(call[0]).toContain("PUT")
      const payload = JSON.parse(call[1].input as string)
      expect(payload.sha).toBeUndefined()
      expect(payload.message).toContain("auto-sync")
      expect(payload.message).toContain("rev 1")
      expect(Buffer.from(payload.content, "base64").toString("utf-8")).toContain('"cursor": "tick-1"')
    })

    it("PUTs with sha when updating an existing file", () => {
      gh.mockReturnValueOnce("{}")
      const wrote = backend().save(
        {
          path: ".kody/jobs/auto-sync.state.json",
          handle: "old-sha",
          state: envelope({ rev: 5, cursor: "before" }),
          created: false,
        },
        envelope({ rev: 6, cursor: "after" }),
      )
      expect(wrote).toBe(true)
      const payload = JSON.parse(gh.mock.calls[0]![1].input as string)
      expect(payload.sha).toBe("old-sha")
    })

    it("skips when state is structurally unchanged (no rev bump impact)", () => {
      const prev = envelope({ rev: 5, cursor: "same", data: { x: 1 } })
      const next = envelope({ rev: 6, cursor: "same", data: { x: 1 } })

      const wrote = backend().save(
        { path: ".kody/jobs/auto-sync.state.json", handle: "sha", state: prev, created: false },
        next,
      )
      expect(wrote).toBe(false)
      expect(gh).not.toHaveBeenCalled()
    })

    it("writes when cursor differs", () => {
      gh.mockReturnValueOnce("{}")
      const prev = envelope({ rev: 5, cursor: "a" })
      const next = envelope({ rev: 6, cursor: "b" })
      const wrote = backend().save(
        { path: ".kody/jobs/auto-sync.state.json", handle: "sha", state: prev, created: false },
        next,
      )
      expect(wrote).toBe(true)
    })

    it("writes when data differs", () => {
      gh.mockReturnValueOnce("{}")
      const prev = envelope({ data: { x: 1 } })
      const next = envelope({ data: { x: 2 } })
      const wrote = backend().save(
        { path: ".kody/jobs/auto-sync.state.json", handle: "sha", state: prev, created: false },
        next,
      )
      expect(wrote).toBe(true)
    })
  })
})
