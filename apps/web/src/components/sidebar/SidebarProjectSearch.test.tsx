import type { ProjectContentMatch } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import commandPaletteSource from "../CommandPalette.tsx?raw";
import sidebarSource from "../Sidebar.tsx?raw";
import {
  SidebarSearchModeSegment,
  sidebarSearchPlaceholder,
  withoutIndentation,
} from "./SidebarProjectSearch";

describe("inline file and content search in the sidebar", () => {
  it("names each mode in German and keeps the thread placeholder", () => {
    expect(sidebarSearchPlaceholder("threads", "Suchen")).toBe("Suchen");
    expect(sidebarSearchPlaceholder("files", "Suchen")).toBe("Datei suchen");
    expect(sidebarSearchPlaceholder("content", "Suchen")).toBe("Im Projekt suchen");
  });

  it("renders the mode segment inline", () => {
    const html = renderToStaticMarkup(
      <SidebarSearchModeSegment mode="files" onModeChange={() => {}} />,
    );
    expect(html).toContain(">Chats<");
    expect(html).toContain("Dateien");
    expect(html).toContain("Inhalt");
    expect(html).not.toContain('role="dialog"');
  });

  it("routes ⌘P and ⌘⇧F to the sidebar field, results inline under it", () => {
    expect(commandPaletteSource).toContain("sidebarSearchModeForCommand(command)");
    expect(commandPaletteSource).toContain("focusSearch(searchMode)");
    expect(commandPaletteSource).not.toContain("ProjectFilePicker");
    expect(commandPaletteSource).not.toContain("ProjectContentSearchDialog");
    expect(sidebarSource).toContain("<SidebarProjectSearchResults");
    expect(sidebarSource).toContain("onSidebarSearchMode(setSearchMode)");
  });
});

describe("content results in the narrow sidebar", () => {
  it("drops indentation and shifts the match ranges with it", () => {
    const match = {
      path: "a.ts",
      lineNumber: 3,
      lineContent: "    const x = 1;",
      matchRanges: [{ start: 10, end: 11 }],
    } as unknown as ProjectContentMatch;
    const trimmed = withoutIndentation(match);
    expect(trimmed.lineContent).toBe("const x = 1;");
    expect(trimmed.matchRanges).toEqual([{ start: 6, end: 7 }]);
    expect(trimmed.lineContent.slice(6, 7)).toBe("x");
  });
});
