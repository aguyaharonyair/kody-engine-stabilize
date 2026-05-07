/**
 * Unit tests for resolveBackend — the configuration-driven entry point that
 * job scripts use to pick a state backend.
 */

import { describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import { ContentsApiBackend } from "../../src/scripts/jobState/contentsApiBackend.js"
import { resolveBackend } from "../../src/scripts/jobState/index.js"
import { LocalFileBackend } from "../../src/scripts/jobState/localFileBackend.js"

function configWith(jobs?: KodyConfig["jobs"]): KodyConfig {
  return {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "acme", repo: "widgets" },
    agent: { model: "anthropic/test" },
    jobs,
  }
}

describe("resolveBackend", () => {
  it("returns ContentsApiBackend by default (no jobs config)", () => {
    const backend = resolveBackend({ config: configWith(undefined), cwd: "/tmp", jobsDir: ".kody/jobs" })
    expect(backend).toBeInstanceOf(ContentsApiBackend)
    expect(backend.name).toBe("contents-api")
  })

  it("returns ContentsApiBackend when explicitly requested", () => {
    const backend = resolveBackend({
      config: configWith({ stateBackend: "contents-api" }),
      cwd: "/tmp",
      jobsDir: ".kody/jobs",
    })
    expect(backend).toBeInstanceOf(ContentsApiBackend)
  })

  it("returns LocalFileBackend when configured", () => {
    const backend = resolveBackend({
      config: configWith({ stateBackend: "local-file" }),
      cwd: "/tmp",
      jobsDir: ".kody/jobs",
    })
    expect(backend).toBeInstanceOf(LocalFileBackend)
    expect(backend.name).toBe("local-file")
  })

  it("throws when github.owner/repo is missing", () => {
    const cfg = configWith()
    cfg.github = { owner: "", repo: "" }
    expect(() => resolveBackend({ config: cfg, cwd: "/tmp", jobsDir: ".kody/jobs" })).toThrow(/owner.*repo/i)
  })
})
