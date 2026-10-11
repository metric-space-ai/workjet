import { afterEach, describe, expect, it } from "vite-plus/test";
import { closeInstanceSetup, instanceSetupStore, openInstanceRePair } from "./instanceSetup";

afterEach(closeInstanceSetup);
describe("instance pairing recovery action", () => {
  for (const source of ["manual_pairing", "pairing_invite"] as const)
    it("replaces the same saved identity for " + source, () => {
      openInstanceRePair({ id: "paired:fixture", source });
      expect(instanceSetupStore.getSnapshot()).toMatchObject({
        intent: "link",
        replacesInstanceId: "paired:fixture",
      });
    });
  it("uses managed setup without replacing accountless pairing", () => {
    openInstanceRePair({ id: "managed:fixture", source: "ctox_dev" });
    expect(instanceSetupStore.getSnapshot()?.intent).toBe("managed");
    expect(instanceSetupStore.getSnapshot()?.replacesInstanceId).toBeUndefined();
  });
});
