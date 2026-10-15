import { describe, expect, it } from "vite-plus/test";

import speechPanelSource from "./SpeechSettingsPanel.tsx?raw";
import { SpeechSettingsError, speechFailureReason } from "../../lib/workjetSpeechSettings";
import { settingsNavItems } from "./settingsNavigation";
import { isSpeechSupported, markSpeechSupport, speechReadFailureView } from "./speechAvailability";

describe("Sprachausgabe ohne Zustandskästen", () => {
  it("core_outdated hides the entry instead of rendering „zu alt“", () => {
    const error = new SpeechSettingsError({ de: "zu alt", en: "too old" }, "core_outdated");
    expect(speechReadFailureView(speechFailureReason(error))).toBe("hide");
    markSpeechSupport("instance-old", false);
    expect(isSpeechSupported("instance-old")).toBe(false);
    const labels = settingsNavItems(false, {
      speechAvailable: isSpeechSupported("instance-old"),
    }).map((item) => item.label);
    expect(labels).not.toContain("Sprachausgabe");
    expect(labels).toHaveLength(7);
    // The page never renders the outdated-core instruction or a reload box.
    expect(speechPanelSource).not.toContain("zu alt");
    expect(speechPanelSource).not.toContain("Erneut laden");
    expect(speechPanelSource).not.toContain("Laden dauert länger");
    markSpeechSupport("instance-old", true);
    expect(settingsNavItems(false, { speechAvailable: true })).toHaveLength(8);
  });

  it("retries read failures quietly and keeps access_denied as one short line", () => {
    for (const reason of ["request_timeout", "peer_unavailable", "unanswered", null] as const) {
      expect(speechReadFailureView(reason)).toBe("retry");
    }
    expect(speechReadFailureView("access_denied")).toBe("denied");
    expect("Keine Berechtigung für Spracheinstellungen".split(" ").length).toBeLessThanOrEqual(12);
  });
});
