import { WorkjetCrossModeResolveBrowserOpsRpcResult } from "@workjet/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { browserBusinessOsLaunchUrl } from "./browserBusinessOsLaunch";

const decode = Schema.decodeUnknownSync(WorkjetCrossModeResolveBrowserOpsRpcResult);
const instance = {
  _tag: "instance",
  schemaVersion: 1,
  connectionId: "connection-a",
  instanceId: "instance-a",
};
const linked = {
  ...instance,
  _tag: "linked-object",
  linkId: "link-a-0000000001",
  ctox: {
    schemaVersion: 1,
    instanceId: "instance-a",
    moduleId: "ctox",
    objectKind: "task",
    objectId: "task-a",
  },
};

describe("browser Business OS launch address", () => {
  it("refuses a path-normalizing instance ID", () => {
    expect(() => browserBusinessOsLaunchUrl(decode({ ...instance, instanceId: ".." }))).toThrow(
      "Instanzadresse",
    );
  });
  it("uses the fixed CTOX issuer and only the verified instance ID", () => {
    const url = new URL(
      browserBusinessOsLaunchUrl(decode({ ...instance, token: "never-forward-this" })),
    );
    expect(url.origin).toBe("https://ctox.dev");
    expect(url.pathname).toBe("/workjet/open/instance-a");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });
  it("preserves a bounded task address without interpreting it as a URL", () => {
    const url = new URL(browserBusinessOsLaunchUrl(decode(linked)));
    expect(url.searchParams.get("app")).toBe("ctox");
    expect(url.searchParams.get("kind")).toBe("task");
    expect(url.searchParams.get("object")).toBe(linked.ctox.objectId);
    expect(url.searchParams.has("next")).toBe(false);
  });
  it("refuses a cross-instance backlink", () => {
    expect(() =>
      browserBusinessOsLaunchUrl(
        decode({ ...linked, ctox: { ...linked.ctox, instanceId: "instance-b" } }),
      ),
    ).toThrow("Instanzzuordnung");
  });
  it("refuses unsupported object kinds instead of opening the wrong view", () => {
    expect(() =>
      browserBusinessOsLaunchUrl(
        decode({ ...linked, ctox: { ...linked.ctox, objectKind: "unknown-record" } }),
      ),
    ).toThrow("noch nicht");
  });
});
