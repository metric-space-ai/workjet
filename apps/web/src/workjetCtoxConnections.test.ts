import { WorkjetConnectionId } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  ctoxConnectionMatchesSelectedInstance,
  lumaConnectionForInstance,
} from "./workjetCtoxConnections";

const source = {
  connectionId: WorkjetConnectionId.make("ctox-dev:tenant-source"),
  instanceId: "source.ctox.dev",
  source: "ctox_dev",
} as const;

describe("CTOX connection selection", () => {
  it("uses the explicit bound source among multiple ready grants, retaining the native pin", () => {
    const ready = { ...source, displayName: "Source", status: "ready" as const, reason: null };
    const worker = {
      ...ready,
      connectionId: WorkjetConnectionId.make(
        "ctox-dev-worker-source:tenant-source:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ),
    };
    expect(lumaConnectionForInstance([ready, worker], "managed:tenant-source", worker)).toBe(
      worker,
    );
    expect(lumaConnectionForInstance([ready, worker], "managed:tenant-source")).toBe(ready);
    expect(
      lumaConnectionForInstance(
        [
          worker,
          {
            ...worker,
            connectionId: WorkjetConnectionId.make(
              "ctox-dev-worker-source:tenant-source:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            ),
          },
        ],
        "managed:tenant-source",
      ),
    ).toBeUndefined();
  });

  it("never falls back from a missing, revoked, foreign or repinned explicit source", () => {
    const ready = { ...source, displayName: "Source", status: "ready" as const, reason: null };
    const worker = {
      ...ready,
      connectionId: WorkjetConnectionId.make(
        "ctox-dev-worker-source:tenant-source:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ),
    };
    expect(lumaConnectionForInstance([ready], "managed:tenant-source", worker)).toBeUndefined();
    expect(
      lumaConnectionForInstance([worker], "managed:tenant-source", {
        connectionId: worker.connectionId,
      }),
    ).toBeUndefined();
    expect(
      lumaConnectionForInstance(
        [ready, { ...worker, status: "needs_auth" }],
        "managed:tenant-source",
        worker,
      ),
    ).toBeUndefined();
    expect(lumaConnectionForInstance([worker], "managed:tenant-other", worker)).toBeUndefined();
    expect(
      lumaConnectionForInstance(
        [{ ...worker, instanceId: "foreign.ctox.dev" }],
        "managed:tenant-source",
        worker,
      ),
    ).toBeUndefined();
  });

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

  it("accepts a new worker client only for its exact selected managed tenant", () => {
    const worker = {
      ...source,
      connectionId: WorkjetConnectionId.make(
        "ctox-dev-worker-source:tenant-source:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ),
    };
    expect(ctoxConnectionMatchesSelectedInstance(worker, "managed:tenant-source")).toBe(true);
    expect(ctoxConnectionMatchesSelectedInstance(worker, "managed:tenant")).toBe(false);
    expect(ctoxConnectionMatchesSelectedInstance(worker, "managed:tenant-other")).toBe(false);
    expect(
      ctoxConnectionMatchesSelectedInstance(
        { ...worker, connectionId: WorkjetConnectionId.make(worker.connectionId + ":foreign") },
        "managed:tenant-source",
      ),
    ).toBe(false);
    expect(ctoxConnectionMatchesSelectedInstance(worker, null)).toBe(false);
  });
});
