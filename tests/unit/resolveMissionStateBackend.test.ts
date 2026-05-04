/**
 * Unit tests for resolveBackend — the configuration-driven entry point that
 * mission scripts use to pick a state backend.
 */

import { describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import { ContentsApiBackend } from "../../src/scripts/missionState/contentsApiBackend.js"
import { resolveBackend } from "../../src/scripts/missionState/index.js"
import { LocalFileBackend } from "../../src/scripts/missionState/localFileBackend.js"

function configWith(missions?: KodyConfig["missions"]): KodyConfig {
  return {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "acme", repo: "widgets" },
    agent: { model: "anthropic/test" },
    missions,
  }
}

describe("resolveBackend", () => {
  it("returns ContentsApiBackend by default (no missions config)", () => {
    const backend = resolveBackend({ config: configWith(undefined), cwd: "/tmp", missionsDir: ".kody/missions" })
    expect(backend).toBeInstanceOf(ContentsApiBackend)
    expect(backend.name).toBe("contents-api")
  })

  it("returns ContentsApiBackend when explicitly requested", () => {
    const backend = resolveBackend({
      config: configWith({ stateBackend: "contents-api" }),
      cwd: "/tmp",
      missionsDir: ".kody/missions",
    })
    expect(backend).toBeInstanceOf(ContentsApiBackend)
  })

  it("returns LocalFileBackend when configured", () => {
    const backend = resolveBackend({
      config: configWith({ stateBackend: "local-file" }),
      cwd: "/tmp",
      missionsDir: ".kody/missions",
    })
    expect(backend).toBeInstanceOf(LocalFileBackend)
    expect(backend.name).toBe("local-file")
  })

  it("throws when github.owner/repo is missing", () => {
    const cfg = configWith()
    cfg.github = { owner: "", repo: "" }
    expect(() => resolveBackend({ config: cfg, cwd: "/tmp", missionsDir: ".kody/missions" })).toThrow(/owner.*repo/i)
  })
})
