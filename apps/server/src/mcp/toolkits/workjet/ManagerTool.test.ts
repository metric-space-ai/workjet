import { expect, it } from "@effect/vitest";

import { containsLikelyPlaintextSecret } from "./ManagerTool.ts";

it("refuses common plaintext credential shapes while allowing opaque handles", () => {
  expect(containsLikelyPlaintextSecret("api_key=super-secret-value-123")).toBe(true);
  expect(containsLikelyPlaintextSecret(["sk", "abcdefghijklmnopqrstuvwxyz012345"].join("-"))).toBe(true);
  expect(
    containsLikelyPlaintextSecret("Use ctox-secret://provider-credentials/openai-primary"),
  ).toBe(false);
  expect(containsLikelyPlaintextSecret("Rotate the expired production credential handle.")).toBe(
    false,
  );
});
