import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_WORKJET_CONFIGURATION, type WorkjetConfiguration } from "./workjet.ts";
import {
  WORKJET_LUMA_INSTANCE_KEYS,
  applyLumaInstanceDocument,
  extractLumaInstanceDocument,
  lumaInstanceNeedsSeed,
} from "./workjetLumaConfiguration.ts";

const localWithComputer = (overrides: Partial<WorkjetConfiguration>): WorkjetConfiguration => ({
  ...DEFAULT_WORKJET_CONFIGURATION,
  ...overrides,
});

describe("workjetLumaConfiguration", () => {
  it("keeps machine state out of the instance document", () => {
    const document = extractLumaInstanceDocument(DEFAULT_WORKJET_CONFIGURATION);

    expect(Object.keys(document).sort()).toEqual([...WORKJET_LUMA_INSTANCE_KEYS].sort());
    expect(document).not.toHaveProperty("computers");
    expect(document).not.toHaveProperty("selectedComputerId");
    expect(document).not.toHaveProperty("schemaVersion");
  });

  it("seeds an empty instance only at revision 0", () => {
    expect(lumaInstanceNeedsSeed(0)).toBe(true);
    expect(lumaInstanceNeedsSeed(1)).toBe(false);
  });

  it("applies the instance document without touching this computer's selection", () => {
    const local = localWithComputer({ managedSystemPrompt: "lokal" });
    const instance = { managedSystemPrompt: "instanzweit", managerThreadReference: "thread-1" };

    const merged = applyLumaInstanceDocument(local, instance);

    expect(merged.managedSystemPrompt).toBe("instanzweit");
    expect(merged.managerThreadReference).toBe("thread-1");
    expect(merged.selectedComputerId).toBe(local.selectedComputerId);
    expect(merged.computers).toBe(local.computers);
  });

  it("leaves local keys in place when the instance document omits them", () => {
    const local = localWithComputer({ managedSystemPrompt: "lokal" });

    const merged = applyLumaInstanceDocument(local, {});

    expect(merged.managedSystemPrompt).toBe("lokal");
  });
});
