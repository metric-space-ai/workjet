import { describe, expect, it } from "vite-plus/test";

import { decodeNativeDecisionHubNotification } from "./decision-hub-notification-payload";

describe("Decision Hub mobile notifications", () => {
  it("accepts only bounded Decision Hub presentation data", () => {
    expect(
      decodeNativeDecisionHubNotification({
        kind: "decision_hub",
        title: "  Architektur   freigeben ",
        body: "Bitte im Decision Hub entscheiden.",
        urgency: "critical",
        tag: "decision-hub:kpl-e-1",
        recordId: "kpl-e-1",
        context: "must not cross the native bridge",
      }),
    ).toEqual({
      kind: "decision_hub",
      title: "Architektur freigeben",
      body: "Bitte im Decision Hub entscheiden.",
      urgency: "critical",
      tag: "decision-hub:kpl-e-1",
      recordId: "kpl-e-1",
    });
  });

  it("rejects foreign or empty payloads and strips unsafe tokens", () => {
    expect(decodeNativeDecisionHubNotification({ kind: "other", title: "x", body: "y" })).toBe(
      null,
    );
    expect(
      decodeNativeDecisionHubNotification({ kind: "decision_hub", title: "", body: "y" }),
    ).toBe(null);
    expect(
      decodeNativeDecisionHubNotification({
        kind: "decision_hub",
        title: "Entscheidung",
        body: "Bitte prüfen.",
        tag: "unsafe token",
        recordId: "../../secret",
      }),
    ).toEqual({
      kind: "decision_hub",
      title: "Entscheidung",
      body: "Bitte prüfen.",
      urgency: "normal",
    });
  });
});
