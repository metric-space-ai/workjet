import { describe, expect, it } from "vite-plus/test";

import { openOnHostLabel, pullRequestLinkContextMenuItems } from "./pullRequestLinkContextMenu";

describe("pull request link context menu", () => {
  it("offers the copy first and the host's own page after it", () => {
    expect(pullRequestLinkContextMenuItems("Auf GitHub öffnen")).toEqual([
      { id: "copy-link", label: "Link kopieren", icon: "copy" },
      { id: "open-external", label: "Auf GitHub öffnen" },
    ]);
  });

  it("names every host it knows, and says nothing false about one it does not", () => {
    expect(openOnHostLabel("github")).toBe("Auf GitHub öffnen");
    expect(openOnHostLabel("gitlab")).toBe("Auf GitLab öffnen");
    expect(openOnHostLabel("bitbucket")).toBe("Auf Bitbucket öffnen");
    expect(openOnHostLabel("azure-devops")).toBe("Auf Azure DevOps öffnen");
    expect(openOnHostLabel("something-else")).toBe("Beim Host öffnen");
  });
});
