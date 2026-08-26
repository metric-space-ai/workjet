import { describe, expect, it } from "vite-plus/test";

import chatViewSource from "./ChatView.tsx?raw";

describe("ChatView split layout", () => {
  it("docks the draft composer when the terminal consumes the lower pane", () => {
    expect(chatViewSource).toContain(
      "const shouldCenterDraftComposer = isDraftHeroState && !terminalUiState.terminalOpen",
    );
    expect(chatViewSource).toContain("shouldCenterDraftComposer\n                  ?");
    expect(chatViewSource).toContain("{shouldCenterDraftComposer ? (");
  });
});
