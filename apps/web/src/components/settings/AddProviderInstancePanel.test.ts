import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderInstanceId,
  newInstanceUsesWorkjetGateway,
  slugifyInstanceLabel,
  validateProviderInstanceId,
} from "./AddProviderInstancePanel.logic";

describe("deriveProviderInstanceId", () => {
  const none = new Set<string>();

  it("derives <driver>_<slug> from the label instead of asking for an id", () => {
    expect(deriveProviderInstanceId("codex", "Work", none)).toBe("codex_work");
    expect(deriveProviderInstanceId("codex", "  Mein Büro 2 ", none)).toBe("codex_mein_b_ro_2");
  });

  it("never reuses the driver's default slot when the label is empty", () => {
    expect(deriveProviderInstanceId("codex", "", none)).toBe("codex_2");
    expect(deriveProviderInstanceId("codex", "   ", new Set(["codex_2"]))).toBe("codex_3");
  });

  it("appends a numeric suffix on collision", () => {
    expect(deriveProviderInstanceId("codex", "Work", new Set(["codex_work"]))).toBe("codex_work_2");
    expect(deriveProviderInstanceId("codex", "Work", new Set(["codex_work", "codex_work_2"]))).toBe(
      "codex_work_3",
    );
  });

  it("always yields an id the validation accepts", () => {
    const existing = new Set(["claudeAgent_x"]);
    for (const label of ["", "x", "123", "!!!", "a".repeat(200)]) {
      const id = deriveProviderInstanceId("claudeAgent", label, existing);
      expect(validateProviderInstanceId(id, existing)).toBeNull();
    }
  });
});

describe("validateProviderInstanceId", () => {
  it("blocks saving with a German status line", () => {
    expect(validateProviderInstanceId("", new Set())).toBe("Name fehlt.");
    expect(validateProviderInstanceId("a".repeat(65), new Set())).toBe("Name zu lang.");
    expect(validateProviderInstanceId("1codex", new Set())).toBe("Name ungültig.");
    expect(validateProviderInstanceId("codex_work", new Set(["codex_work"]))).toBe(
      "Name bereits vergeben.",
    );
    expect(validateProviderInstanceId("codex_work", new Set())).toBeNull();
  });
});

describe("slugifyInstanceLabel", () => {
  it("keeps the composed id under the 64-char cap", () => {
    expect(slugifyInstanceLabel("x".repeat(100))).toHaveLength(48);
  });
});

describe("newInstanceUsesWorkjetGateway", () => {
  it("routes new gateway-capable harnesses through the gateway", () => {
    expect(newInstanceUsesWorkjetGateway("codex")).toBe(true);
    expect(newInstanceUsesWorkjetGateway("cursor")).toBe(false);
  });
});
