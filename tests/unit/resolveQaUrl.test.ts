import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { resolveQaUrl } from "../../src/scripts/resolveQaUrl.js"

function makeCtx(overrides: Partial<Context["args"]> = {}, qa?: { fallbackUrl?: string }): Context {
  return {
    args: { ...overrides },
    cwd: "/tmp",
    config: {
      quality: { typecheck: "", lint: "", format: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "owner", repo: "repo" },
      agent: { model: "anthropic/claude-sonnet-4-5" },
      qa,
    },
    data: {},
    output: { exitCode: 0 },
  }
}

const stubProfile = { name: "qa-engineer", dir: "" } as unknown as Profile

describe("resolveQaUrl", () => {
  let originalPreviewUrl: string | undefined

  beforeEach(() => {
    originalPreviewUrl = process.env.PREVIEW_URL
    delete process.env.PREVIEW_URL
  })

  afterEach(() => {
    if (originalPreviewUrl === undefined) delete process.env.PREVIEW_URL
    else process.env.PREVIEW_URL = originalPreviewUrl
    vi.restoreAllMocks()
  })

  it("uses --url when provided, ignoring everything else", async () => {
    process.env.PREVIEW_URL = "https://env.example.com"
    const ctx = makeCtx(
      { url: "https://explicit.example.com", goal: "some-goal" },
      { fallbackUrl: "https://fallback.example.com" },
    )
    await resolveQaUrl(ctx, stubProfile)
    expect(ctx.data.previewUrl).toBe("https://explicit.example.com")
    expect(ctx.data.previewUrlSource).toBe("--url flag")
  })

  it("falls back to $PREVIEW_URL when neither --url nor --goal yields", async () => {
    process.env.PREVIEW_URL = "https://env.example.com"
    const ctx = makeCtx({})
    await resolveQaUrl(ctx, stubProfile)
    expect(ctx.data.previewUrl).toBe("https://env.example.com")
    expect(ctx.data.previewUrlSource).toBe("$PREVIEW_URL env var")
  })

  it("falls back to qa.fallbackUrl from kody.config.json when env is empty", async () => {
    const ctx = makeCtx({}, { fallbackUrl: "https://dev.example.com" })
    await resolveQaUrl(ctx, stubProfile)
    expect(ctx.data.previewUrl).toBe("https://dev.example.com")
    expect(ctx.data.previewUrlSource).toBe("kody.config.json qa.fallbackUrl")
  })

  it("trims whitespace on every source", async () => {
    process.env.PREVIEW_URL = "  https://env.example.com  "
    const ctx = makeCtx({})
    await resolveQaUrl(ctx, stubProfile)
    expect(ctx.data.previewUrl).toBe("https://env.example.com")
  })

  it("throws when no URL resolves anywhere", async () => {
    const ctx = makeCtx({})
    await expect(resolveQaUrl(ctx, stubProfile)).rejects.toThrow(/no URL resolved/i)
  })

  it("ignores empty --url and continues to the next source", async () => {
    process.env.PREVIEW_URL = "https://env.example.com"
    const ctx = makeCtx({ url: "   " })
    await resolveQaUrl(ctx, stubProfile)
    expect(ctx.data.previewUrl).toBe("https://env.example.com")
  })

  it("when --goal is set but no deployment is found, falls back to env/config", async () => {
    process.env.PREVIEW_URL = "https://env.example.com"
    // Without mocking gh, the deployment lookup yields null in this environment
    // (no real GitHub API access). We assert the preflight degrades gracefully
    // rather than crashing.
    const ctx = makeCtx({ goal: "nonexistent-goal-id-for-test" })
    await resolveQaUrl(ctx, stubProfile)
    expect(ctx.data.previewUrl).toBe("https://env.example.com")
    expect(ctx.data.previewUrlSource).toBe("$PREVIEW_URL env var")
  })
})
