import { describe, expect, it } from "vite-plus/test";
import { cloneFailureMessage } from "./ProjectCreateSources.logic";

const repo = "https://github.com/metric-space-ai/metric";

describe("cloneFailureMessage", () => {
  it("explains auth failures in de and en", () => {
    const failure = { detail: "clone-failed:auth fatal: could not read Username" };
    expect(cloneFailureMessage(failure, repo, "de")).toContain(
      "Kein Zugriff auf metric-space-ai/metric",
    );
    expect(cloneFailureMessage(failure, repo, "en")).toContain(
      "No access to metric-space-ai/metric",
    );
  });

  it("names the host for network failures", () => {
    const failure = { detail: "clone-failed:network fatal: unable to access" };
    expect(cloneFailureMessage(failure, repo, "en")).toBe(
      "Can't reach github.com. Check the internet connection and try again.",
    );
  });

  it("keeps git's reason for unknown failures instead of a generic sentence", () => {
    const failure = { detail: "clone-failed:unknown fatal: something odd" };
    expect(cloneFailureMessage(failure, repo, "de")).toBe(
      "Klonen von metric-space-ai/metric fehlgeschlagen. (fatal: something odd)",
    );
  });

  it("never shows the raw RPC sentence", () => {
    const failure = new Error(
      "Source control repository operation cloneRepository failed for unknown: The source control operation could not be completed.",
    );
    expect(cloneFailureMessage(failure, repo, "en")).not.toContain(
      "Source control repository operation",
    );
  });
});
