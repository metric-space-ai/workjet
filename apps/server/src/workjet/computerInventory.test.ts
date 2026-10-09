import {
  EnvironmentId,
  WorkjetComputerId,
  WorkjetWorkerProfileId,
  WorkjetComputerInventory,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { computerInventory } from "./computerInventory.ts";

const decodeInventory = Schema.decodeUnknownSync(WorkjetComputerInventory);

describe("computer inventory", () => {
  it("retains public IDs and configured capability metadata without execution paths", () => {
    const id = WorkjetComputerId.make("computer-a");
    const profile = {
      id: WorkjetWorkerProfileId.make("profile-a"),
      name: "Review",
      computerId: id,
      harness: "claude-code" as const,
      role: "standard" as const,
      capabilityIds: [],
      instructions: "private-profile-instructions",
    };
    const inventory = computerInventory({
      computers: [
        {
          id,
          label: "Build host",
          environmentId: EnvironmentId.make("environment-a"),
          presentationKind: "ssh",
          harnesses: [
            { harness: "claude-code", available: false, executableOverride: "/private/executable" },
          ],
        },
      ],
      workerProfiles: [profile],
    });
    expect(decodeInventory(inventory)).toEqual(inventory);
    expect(inventory.computers[0]?.profiles[0]?.id).toBe("profile-a");
    expect(inventory.computers[0]?.harnesses).toEqual([
      { harness: "claude-code", available: false },
    ]);
    expect(JSON.stringify(inventory)).not.toContain("/private/executable");
    expect(JSON.stringify(inventory)).not.toContain("private-profile-instructions");
  });
  it("returns an empty inventory without inventing computers", () => {
    expect(computerInventory({ computers: [], workerProfiles: [] })).toEqual({
      schemaVersion: 1,
      computers: [],
    });
  });
});
