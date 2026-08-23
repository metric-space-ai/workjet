// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it } from "vite-plus/test";

import {
  joinManagedPrompt,
  replaceSectionBody,
  sectionBody,
  splitManagedPrompt,
} from "./managedPromptSections";

// Shaped like the real thing: a preamble, then the sections the Swift page
// shows as separate cards.
const PROMPT = `You are Fable, the sole Workjet orchestrator.

## Routing

1. For a small, bounded change, do it directly.

## Progress board

The board is a KANBAN, not a status page.

### Storage

Never the scratchpad.
`;

describe("splitting the managed prompt for display", () => {
  it("splits at the shallowest heading level, not at every heading", () => {
    // `### Storage` belongs INSIDE Progress board. Splitting at every heading
    // would shred one section into three and invent structure the operator
    // never wrote.
    const sections = splitManagedPrompt(PROMPT);

    expect(sections.map((section) => section.title)).toEqual([null, "Routing", "Progress board"]);
    expect(sectionBody(sections[2]!)).toContain("### Storage");
  });

  it("treats a prompt with no headings as one section rather than an error", () => {
    // Exactly what a hand-written prompt looks like before anyone adds one.
    const sections = splitManagedPrompt("Just some rules.\nAnd more.");

    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBeNull();
    expect(sectionBody(sections[0]!)).toBe("Just some rules.\nAnd more.");
  });

  it("round-trips byte for byte", () => {
    // The load-bearing property. A view that quietly reformats the operator's
    // prompt corrupts the thing it exists to display, and silently — nobody
    // rereads 6 KB of prompt to check it survived.
    expect(joinManagedPrompt(splitManagedPrompt(PROMPT))).toBe(PROMPT);
  });

  it("round-trips an empty prompt and one that is only a heading", () => {
    for (const input of ["", "## Only a heading", "\n\n", "text\n"]) {
      expect(joinManagedPrompt(splitManagedPrompt(input))).toBe(input);
    }
  });

  it("changes one section and leaves every other byte alone", () => {
    const sections = splitManagedPrompt(PROMPT);
    const edited = replaceSectionBody(sections, 1, "\nRewritten.\n");
    const joined = joinManagedPrompt(edited);

    expect(joined).toContain("## Routing\n\nRewritten.\n");
    // The preamble and the later section are untouched.
    expect(joined).toContain("You are Fable, the sole Workjet orchestrator.");
    expect(joined).toContain("The board is a KANBAN, not a status page.");
    expect(joined).not.toContain("For a small, bounded change");
  });
});
