import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  businessOsInstanceForEnvironment,
  createBusinessOsEnvironmentBinding,
  environmentForBusinessOsInstance,
} from "./business-os-environment-binding";

describe("Business OS Code environment bindings", () => {
  const environmentA = EnvironmentId.make("environment-a");
  const environmentB = EnvironmentId.make("environment-b");
  const bindings = [
    createBusinessOsEnvironmentBinding("instance-a", environmentA),
    createBusinessOsEnvironmentBinding("instance-b", environmentB),
  ];

  it("keeps two CTOX instances mapped to their own complete Code environments", () => {
    expect(environmentForBusinessOsInstance(bindings, "instance-a")).toBe(environmentA);
    expect(environmentForBusinessOsInstance(bindings, "instance-b")).toBe(environmentB);
    expect(businessOsInstanceForEnvironment(bindings, environmentA)).toBe("instance-a");
    expect(businessOsInstanceForEnvironment(bindings, environmentB)).toBe("instance-b");
  });

  it("fails closed for unbound instances and environments", () => {
    expect(environmentForBusinessOsInstance(bindings, "missing")).toBeNull();
    expect(businessOsInstanceForEnvironment(bindings, EnvironmentId.make("missing"))).toBeNull();
  });

  it("stores identifiers only, never pairing or business data", () => {
    expect(Object.keys(bindings[0]!)).toEqual(["businessOsInstanceId", "environmentId"]);
    expect(JSON.stringify(bindings)).not.toMatch(
      /password|secret|token|signaling|payload|record|thread/iu,
    );
  });
});
