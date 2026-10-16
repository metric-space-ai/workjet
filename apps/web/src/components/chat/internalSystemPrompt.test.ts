import { describe, expect, it } from "vite-plus/test";
import { internalSystemPromptLabel } from "./internalSystemPrompt";

describe("internalSystemPromptLabel", () => {
  it("erkennt den Wochenbericht-Auftrag in beiden Sprachen", () => {
    const text = "Write this project's weekly report in this supervisor chat, as of 2026-10-16.";
    expect(internalSystemPromptLabel(text, "de")).toBe("Wochenbericht automatisch angefordert");
    expect(internalSystemPromptLabel(text, "en")).toBe("Weekly report requested automatically");
  });
  it("lässt normale Nachrichten unverändert", () => {
    expect(internalSystemPromptLabel("Bitte schreib den Wochenbericht", "de")).toBeNull();
  });
});
