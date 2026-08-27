import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadEnvironmentInActiveBusinessOsScope } from "./business-os-thread-scope";

const environment = (value: string) => EnvironmentId.make(value);

describe("Business OS thread selection scope", () => {
  it("keeps Coding-only operation global before any Business OS binding exists", () => {
    expect(
      isThreadEnvironmentInActiveBusinessOsScope({
        environmentId: environment("unbound"),
        activeEnvironmentIds: [],
        hasEnvironmentBindings: false,
      }),
    ).toBe(true);
  });

  it("fails closed for a thread outside the active Business OS instance", () => {
    expect(
      isThreadEnvironmentInActiveBusinessOsScope({
        environmentId: environment("instance-b-computer"),
        activeEnvironmentIds: [environment("instance-a-computer")],
        hasEnvironmentBindings: true,
      }),
    ).toBe(false);
  });

  it("allows a thread after its environment belongs to the active instance", () => {
    const active = environment("instance-a-computer");
    expect(
      isThreadEnvironmentInActiveBusinessOsScope({
        environmentId: active,
        activeEnvironmentIds: [active],
        hasEnvironmentBindings: true,
      }),
    ).toBe(true);
  });
});
