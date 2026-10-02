import { describe, expect, it } from "vite-plus/test";
import { GreppySettings } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { buildGreppyAcpSpawnInput } from "../acp/GreppyAcpSupport.ts";
import { greppyPermissionOption } from "../Layers/GreppyAdapter.ts";
import { classifyGreppyVersion, plainHttpEndpoint } from "./GreppyProtocol.ts";

const settings = Schema.decodeUnknownSync(GreppySettings)({ model: "fixture-model", maxTurns: 4 });

describe("Greppy ACP boundary", () => {
  it("launches stdio ACP in the host worktree with the routed gateway", () => {
    const input = buildGreppyAcpSpawnInput(
      settings,
      "/fixture/worktree",
      { GREPPY_ENDPOINT: "http://127.0.0.1:9911", GREPPY_API_KEY: "fixture-key" },
      "selected-model",
    );
    expect(input.command).toBe("greppy");
    expect(input.cwd).toBe("/fixture/worktree");
    expect(input.args).toEqual([
      "agent",
      "stdio",
      "--model",
      "selected-model",
      "--endpoint",
      "http://127.0.0.1:9911",
      "--max-turns",
      "4",
    ]);
    expect(input.env?.GREPPY_API_KEY).toBe("fixture-key");
    expect(input.args).not.toContain("fixture-key");
  });
  it("retains model ids and configured binary paths without shell interpolation", () => {
    const input = buildGreppyAcpSpawnInput(
      { ...settings, binaryPath: "/fixture/bin/greppy", maxTurns: -1 },
      "/fixture",
      {},
      "vendor/model name",
    );
    expect(input.command).toBe("/fixture/bin/greppy");
    expect(input.args[3]).toBe("vendor/model name");
    expect(input.args.at(-1)).toBe("1");
  });
  it("maps permission decisions only to advertised matching options", () => {
    const request = {
      sessionId: "fixture",
      toolCall: { toolCallId: "call", title: "Fixture" },
      options: [
        { optionId: "once", kind: "allow_once" as const, name: "Once" },
        { optionId: "deny", kind: "reject_once" as const, name: "Deny" },
      ],
    };
    expect(greppyPermissionOption(request, "accept")).toBe("once");
    expect(greppyPermissionOption(request, "acceptForSession")).toBe("once");
    expect(greppyPermissionOption(request, "decline")).toBe("deny");
    expect(greppyPermissionOption(request, "cancel")).toBeUndefined();
    expect(greppyPermissionOption({ ...request, options: [] }, "accept")).toBeUndefined();
  });
  it("rejects unsupported or credential-bearing endpoints", () => {
    expect(plainHttpEndpoint("http://127.0.0.1:8317/")).toBe("http://127.0.0.1:8317");
    expect(plainHttpEndpoint("https://fixture.example")).toBeNull();
    expect(plainHttpEndpoint("http://secret@fixture.example")).toBeNull();
  });
  it("distinguishes supported source versions without treating version as proof of ACP", () => {
    expect(classifyGreppyVersion("greppy 0.4.1")).toEqual({ kind: "supported", version: "0.4.1" });
    expect(classifyGreppyVersion("greppy 0.3.9")).toEqual({
      kind: "unsupported",
      version: "0.3.9",
    });
    expect(classifyGreppyVersion("custom development build")).toEqual({ kind: "unknown" });
  });
});
