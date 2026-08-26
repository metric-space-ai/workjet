import { describe, expect, it } from "vite-plus/test";

import { resolveRenameCommit } from "./ChatHeader";
import chatHeaderSource from "./ChatHeader.tsx?raw";

describe("ChatHeader chrome", () => {
  it("keeps project scripts, editor launchers, and git actions out of the main header", () => {
    expect(chatHeaderSource).not.toContain("ProjectScriptsControl");
    expect(chatHeaderSource).not.toContain("OpenInPicker");
    expect(chatHeaderSource).not.toContain("GitActionsControl");
    expect(chatHeaderSource).not.toContain("data-chat-header-actions");
  });
});

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});
