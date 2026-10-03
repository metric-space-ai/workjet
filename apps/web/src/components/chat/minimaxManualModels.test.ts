import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { getMiniMaxManualModelCatalog } from "./minimaxManualModels";

const model = "MiniMax-M3.1-Flash-Preview";
const provider = (instance: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instance), driver: ProviderDriverKind.make("minimax"),
  enabled: true, installed: true, version: "0.6.2", status: "ready", auth: { status: "authenticated" },
  checkedAt: "2026-10-03T12:00:00.000Z", models: [{ slug: model, name: model, isCustom: false, capabilities: null }], slashCommands: [], skills: [],
});

describe("MiniMax manual catalog boundaries", () => {
  it("uses the selected native instance and preserves exact runtime model IDs", () => {
    const selected = provider("selected");
    const other = { ...provider("other-computer"), models: [{ slug: "other-model", name: "Other", isCustom: false, capabilities: null }] };
    const catalog = getMiniMaxManualModelCatalog([other, selected], selected.instanceId);
    expect(catalog.models).toEqual([{ id: model, displayName: model, providers: ["minimax"], accountIds: [] }]);
    expect(catalog.unavailableReason).toBeNull();
    expect(getMiniMaxManualModelCatalog([other], selected.instanceId).models).toEqual([]);
  });
  it("never treats another driver, disabled instance or unknown login as native availability", () => {
    const selected = provider("selected");
    for (const unavailable of [
      { ...selected, driver: ProviderDriverKind.make("codex") },
      { ...selected, enabled: false },
      { ...selected, auth: { status: "unknown" as const }, message: "Check this computer's account" },
    ]) expect(getMiniMaxManualModelCatalog([unavailable], selected.instanceId).models).toEqual([]);
    expect(getMiniMaxManualModelCatalog([{ ...selected, auth: { status: "unauthenticated" }, message: "Run mcode login" }], selected.instanceId).unavailableReason).toBe("Run mcode login");
  });
});
