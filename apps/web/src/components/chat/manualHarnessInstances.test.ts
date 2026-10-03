import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { resolveManualHarnessInstances } from "./manualHarnessInstances";

const provider = (id: string, driver = "greppy", enabled = true): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(driver),
  enabled,
  installed: true,
  version: "0.4.1",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-10-03T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});
const selected = ProviderInstanceId.make("greppy-fixture");

describe("manual harness instance routing", () => {
  it("targets an enabled named Greppy profile when its default is disabled", () => {
    const targets = resolveManualHarnessInstances(
      deriveProviderInstanceEntries([
        provider("greppy", "greppy", false),
        provider("greppy-fixture"),
      ]),
      selected,
      null,
    );
    expect(targets.get("greppy")).toBe("greppy-fixture");
  });

  it("preserves the exact active profile rather than switching endpoints", () => {
    const entries = deriveProviderInstanceEntries([provider("greppy-fixture"), provider("greppy")]);
    expect(resolveManualHarnessInstances(entries, selected, null).get("greppy")).toBe(selected);
    expect(
      resolveManualHarnessInstances(entries.toReversed(), selected, null).get("greppy"),
    ).toBe(selected);
  });

  it("prefers the enabled default when entering a different harness family", () => {
    const entries = deriveProviderInstanceEntries([provider("greppy-work"), provider("greppy")]);
    expect(
      resolveManualHarnessInstances(entries, ProviderInstanceId.make("codex"), null).get("greppy"),
    ).toBe("greppy");
  });

  it("never routes to an unavailable or disabled profile", () => {
    const entries = deriveProviderInstanceEntries([
      { ...provider("greppy"), availability: "unavailable" },
      provider("greppy-fixture", "greppy", false),
    ]);
    expect(resolveManualHarnessInstances(entries, selected, null).size).toBe(0);
  });

  it("respects the current continuation driver lock", () => {
    const entries = deriveProviderInstanceEntries([
      provider("greppy-fixture"),
      provider("codex", "codex"),
    ]);
    const targets = resolveManualHarnessInstances(entries, selected, "greppy");
    expect([...targets.entries()]).toEqual([["greppy", selected]]);
  });
});
