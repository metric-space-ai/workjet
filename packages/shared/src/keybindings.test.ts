import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

describe("default keybindings", () => {
  it("ships one canonical new-chat shortcut", () => {
    expect(DEFAULT_KEYBINDINGS.filter((binding) => binding.command === "chat.new")).toEqual([
      { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
    ]);
  });
});
