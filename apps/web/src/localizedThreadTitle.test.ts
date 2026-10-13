import { describe, expect, it } from "vite-plus/test";
import { localizedThreadTitle } from "./localizedThreadTitle";

describe("localizedThreadTitle", () => {
  it("shows the supervisor thread in the UI language", () => {
    expect(localizedThreadTitle("Project supervisor", "de")).toBe("Projekt-Supervisor");
    expect(localizedThreadTitle("Project supervisor", "en")).toBe("Project supervisor");
  });
  it("leaves user titles alone", () => {
    expect(localizedThreadTitle("Landing page", "de")).toBe("Landing page");
  });
});
