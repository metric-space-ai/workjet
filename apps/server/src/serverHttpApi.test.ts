import { describe, expect, it } from "@effect/vitest";

import { ServerEnvironmentHttpApi } from "./serverHttpApi.ts";

describe("server HTTP API hardcut", () => {
  it("does not expose the legacy Business OS mobile control group", () => {
    expect(Object.hasOwn(ServerEnvironmentHttpApi.groups, "businessOs")).toBe(false);
  });
});
