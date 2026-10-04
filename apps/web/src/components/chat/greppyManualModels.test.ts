import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { getGreppyManualModelCatalog } from "./greppyManualModels";

const provider = (instanceId: string, driver: string, slug: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "0.4.1",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-10-03T00:00:00.000Z",
  models: [{ slug, name: slug, isCustom: false, capabilities: {} }],
  slashCommands: [],
  skills: [],
});

describe("direct Greppy manual model catalog", () => {
  it("uses only the exact selected profile and preserves its opaque model ID", () => {
    const entries = deriveProviderInstanceEntries([
      provider("greppy", "greppy", "default-model"),
      provider("greppy_work", "greppy", "company/custom-model:v1"),
      provider("codex", "codex", "gateway-only-model"),
    ]);
    const selected = entries.find((entry) => entry.instanceId === "greppy_work");
    expect(getGreppyManualModelCatalog(selected, false)).toEqual([
      {
        id: "company/custom-model:v1",
        displayName: "company/custom-model:v1",
        providers: [],
        accountIds: [],
      },
    ]);
  });

  it("keeps configured choices while authentication is unknown", () => {
    const [entry] = deriveProviderInstanceEntries([provider("greppy", "greppy", "claude-local")]);
    expect(entry?.snapshot.auth.status).toBe("unknown");
    expect(getGreppyManualModelCatalog(entry, false)?.[0]?.id).toBe("claude-local");
  });

  it("uses the existing gateway catalog only when routing through that gateway", () => {
    const [entry] = deriveProviderInstanceEntries([provider("greppy", "greppy", "local-model")]);
    expect(getGreppyManualModelCatalog(entry, true)).toBeNull();
  });

  it("does not borrow models from another driver or a missing instance", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider("greppy_other", "codex", "other-model"),
    ]);
    expect(getGreppyManualModelCatalog(entry, false)).toBeNull();
    expect(getGreppyManualModelCatalog(undefined, false)).toBeNull();
  });

  it("leaves an empty direct profile empty for the custom-ID editor", () => {
    const [entry] = deriveProviderInstanceEntries([
      { ...provider("greppy", "greppy", "unused"), models: [] },
    ]);
    expect(getGreppyManualModelCatalog(entry, false)).toEqual([]);
  });
});
