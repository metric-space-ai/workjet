import { WorkjetConnectionId } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { ctoxConnectionMatchesSelectedInstance } from "./workjetCtoxConnections";

const source = {
  connectionId: WorkjetConnectionId.make("ctox-dev:tenant-source"),
  instanceId: "source.ctox.dev",
  source: "ctox_dev",
} as const;

describe("CTOX connection selection", () => {
  it("finds the selected managed tenant while retaining its different native instance ID", () => {
    expect(ctoxConnectionMatchesSelectedInstance(source, "managed:tenant-source")).toBe(true);
    expect(source.instanceId).toBe("source.ctox.dev");
    expect(ctoxConnectionMatchesSelectedInstance(source, "source.ctox.dev")).toBe(true);
  });

  it("does not offer a different tenant or accept an empty managed identity", () => {
    expect(ctoxConnectionMatchesSelectedInstance(source, "managed:tenant-other")).toBe(false);
    expect(ctoxConnectionMatchesSelectedInstance(source, "managed:")).toBe(false);
    expect(ctoxConnectionMatchesSelectedInstance(source, "other.ctox.dev")).toBe(false);
  });

  it("requires the managed source type before resolving a managed catalog alias", () => {
    expect(
      ctoxConnectionMatchesSelectedInstance(
        { ...source, source: "local_ctox" },
        "managed:tenant-source",
      ),
    ).toBe(false);
    expect(
      ctoxConnectionMatchesSelectedInstance({ ...source, source: "local_ctox" }, "source.ctox.dev"),
    ).toBe(true);
    expect(ctoxConnectionMatchesSelectedInstance(source, null)).toBe(false);
    expect(ctoxConnectionMatchesSelectedInstance(source, null, true)).toBe(true);
  });
});
