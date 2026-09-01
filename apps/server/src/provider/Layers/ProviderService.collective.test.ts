import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { compileCollectiveManagedInstructions } from "./ProviderService.ts";

const managerThreadId = ThreadId.make("manager-thread");

it("marks only the configured manager thread with manager authority", () => {
  const reference = "workjet://app/threads/ctox-environment/manager-thread";
  const manager = compileCollectiveManagedInstructions("Global rule.", reference, managerThreadId);
  const worker = compileCollectiveManagedInstructions(
    "Global rule.",
    reference,
    ThreadId.make("worker-thread"),
  );

  expect(manager).toContain("You are the dedicated Workjet Manager");
  expect(manager).toContain("Global rule.");
  expect(worker).toContain(reference);
  expect(worker).not.toContain("You are the dedicated Workjet Manager");
});

it("does not treat an invalid link as a manager identity", () => {
  expect(
    compileCollectiveManagedInstructions(
      "Global rule.",
      "https://example.test/manager-thread",
      managerThreadId,
    ),
  ).toBe("Global rule.");
});
