import { describe, expect, it } from "vite-plus/test";

import {
  WORKJET_STATUS_DOT_CLASS,
  workjetStatusFromConnectionPhase,
  workjetStatusFromModelsHealth,
  workjetStatusFromProvider,
  workjetStatusWord,
} from "./workjetStatus";

describe("central status vocabulary", () => {
  it("has exactly five words in both languages, with a reason only for blocked", () => {
    expect(workjetStatusWord("running", null, "de")).toBe("läuft");
    expect(workjetStatusWord("blocked", "Anmeldung", "de")).toBe("blockiert (Anmeldung)");
    expect(workjetStatusWord("missing", "ignored", "en")).toBe("missing");
    expect(Object.keys(WORKJET_STATUS_DOT_CLASS)).toEqual([
      "ok",
      "running",
      "waiting",
      "blocked",
      "missing",
    ]);
  });
  it("maps every source enum onto the same states", () => {
    expect(workjetStatusFromConnectionPhase("connected")).toBe("ok");
    expect(workjetStatusFromConnectionPhase("reconnecting")).toBe("waiting");
    expect(workjetStatusFromProvider("error")).toBe("blocked");
    expect(workjetStatusFromProvider("disabled")).toBe("missing");
    expect(workjetStatusFromModelsHealth("cooldown")).toBe("waiting");
    expect(workjetStatusFromModelsHealth("auth-required")).toBe("blocked");
  });
});
