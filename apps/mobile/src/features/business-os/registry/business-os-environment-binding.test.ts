import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  businessOsInstanceForEnvironment,
  createBusinessOsEnvironmentBinding,
  environmentsForBusinessOsInstance,
} from "./business-os-environment-binding";

describe("Business OS Code environment bindings", () => {
  const environmentA = EnvironmentId.make("environment-a");
  const environmentB = EnvironmentId.make("environment-b");
  const bindings = [
    createBusinessOsEnvironmentBinding("instance-a", environmentA),
    createBusinessOsEnvironmentBinding("instance-a", environmentB),
  ];

  it("keeps every Code machine scoped under its CTOX instance", () => {
    expect(environmentsForBusinessOsInstance(bindings, "instance-a")).toEqual([
      environmentA,
      environmentB,
    ]);
    expect(environmentsForBusinessOsInstance(bindings, "instance-b")).toEqual([]);
    expect(businessOsInstanceForEnvironment(bindings, environmentA)).toBe("instance-a");
    expect(businessOsInstanceForEnvironment(bindings, environmentB)).toBe("instance-a");
  });

  it("fails closed for unbound instances and environments", () => {
    expect(environmentsForBusinessOsInstance(bindings, "missing")).toEqual([]);
    expect(businessOsInstanceForEnvironment(bindings, EnvironmentId.make("missing"))).toBeNull();
  });

  it("stores identifiers only, never pairing or business data", () => {
    expect(Object.keys(bindings[0]!)).toEqual(["businessOsInstanceId", "environmentId"]);
    expect(JSON.stringify(bindings)).not.toMatch(
      /password|secret|token|signaling|payload|record|thread/iu,
    );
  });
});
