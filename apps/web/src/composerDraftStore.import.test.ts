import { describe, expect, it, vi } from "vite-plus/test";

describe("composer module startup", () => {
  it.each(["private chat", "composer draft"])(
    "loads an isolated draft store when %s is the entry point",
    async (entry) => {
      vi.resetModules();
      if (entry === "private chat") await import("./workjetPrivateChat");
      const { useComposerDraftStore } = await import("./composerDraftStore");
      expect(typeof useComposerDraftStore.getState).toBe("function");
      expect(() => useComposerDraftStore.getState()).not.toThrow();
      const { createWorkjetPrivateChat } = await import("./workjetPrivateChat");
      expect(typeof createWorkjetPrivateChat).toBe("function");
    },
  );
});
