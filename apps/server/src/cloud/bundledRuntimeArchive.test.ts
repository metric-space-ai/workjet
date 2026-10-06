import { describe, expect, it } from "vite-plus/test";
import { BundledRuntimeArchiveError } from "./bundledRuntime.ts";

describe("bundled runtime archive diagnostics", () => {
  it("identifies a terminated extraction without leaking the command or stderr", () => {
    const failure = Object.assign(new Error("tar /private/profile/secret.tgz"), {
      code: null,
      signal: "SIGTERM",
      killed: true,
      stderr: "secret-token",
      stdout: "private archive contents",
      cmd: "tar -xzf /private/profile/secret.tgz",
    });
    const error = new BundledRuntimeArchiveError("extract", 180_000, failure);
    expect(error).toMatchObject({
      name: "BundledRuntimeArchiveError",
      operation: "extract",
      timeoutMs: 180_000,
      exitCode: null,
      signal: "SIGTERM",
      killed: true,
    });
    expect(error.message).toContain("limit 180000 ms");
    expect(JSON.stringify(error) + error.stack).not.toMatch(/secret|private archive|tar -xzf/);
    expect(error.cause).toBeUndefined();
  });

  it("distinguishes an ordinary tar failure from a terminated child", () => {
    const error = new BundledRuntimeArchiveError("list", 30_000, {
      code: 2,
      signal: null,
      killed: false,
      stderr: "untrusted archive bytes",
    });
    expect(error).toMatchObject({ operation: "list", exitCode: 2, signal: null, killed: false });
    expect(error.message).toContain("exit 2");
    expect(error.message).not.toContain("untrusted");
  });

  it.each([
    null,
    undefined,
    "secret",
    { code: "secret", signal: "secret", killed: "true" },
    { code: Infinity, signal: "SIGTERM\nsecret" },
  ])("does not expose malformed subprocess metadata: %j", (failure) => {
    const error = new BundledRuntimeArchiveError("extract", 180_000, failure);
    expect(error).toMatchObject({ exitCode: null, signal: null, killed: false });
    expect(JSON.stringify(error) + error.message).not.toContain("secret");
  });
});
