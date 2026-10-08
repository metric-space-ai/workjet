import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { JourFixeRoom } from "./JourFixeRoom";
import type { JourFixeRoomSnapshot } from "../lib/jourFixeRoom";
import fixture from "../fixtures/jour-fixe.contract.json";

const meeting = fixture.meeting as JourFixeRoomSnapshot;
const props = { projectTitle: "Fixture", meeting, onBack: () => {} };

describe("Jour fixe room states", () => {
  it("opens native review in the main area without claiming the goal is confirmed", () => {
    const html = renderToStaticMarkup(<JourFixeRoom {...props} onConfirmTodos={async () => {}} />);
    expect(html).toContain('data-workjet-meeting-review=""');
    expect(html).toContain("Proposed to-dos");
    expect(html).toContain("Verify persistence");
    expect(html).toContain("Comment 1 · Slide 1");
    expect(html).toContain("Transcript 1");
    expect(html).not.toContain("Confirmed to-dos");
  });
  it("renders planned/preparing without live editing controls or narration", () => {
    for (const state of ["planned", "preparing"] as const) {
      const html = renderToStaticMarkup(
        <JourFixeRoom
          {...props}
          meeting={{ ...meeting, state, slides: [] }}
          onComment={async () => {}}
          onMessage={async () => {}}
        />,
      );
      expect(html).not.toContain("Place a comment on the slide");
      expect(html).not.toContain("Message to supervisor");
      expect(html).toContain(state === "preparing" ? "preparing the deck" : "No deck is available");
    }
  });
  it("does not execute HTML or fetch arbitrary remote images from slide markdown", () => {
    const html = renderToStaticMarkup(
      <JourFixeRoom
        {...props}
        meeting={{
          ...meeting,
          state: "live",
          slides: [
            {
              id: "slide-1",
              position: 0,
              title: "Evidence",
              markdown:
                "<script>alert(1)</script>\n\n![remote](https://foreign.invalid/image.png)\n\n[link](javascript:alert(1))",
            },
          ],
        }}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("foreign.invalid");
  });
  it("keeps native transcript order across streams and initially bounds the rendered history", () => {
    const transcript = Array.from({ length: 120 }, (_, index) => ({
      id: `turn-${index}`,
      sequence: index % 2,
      speaker: "owner" as const,
      text: `Evidence turn ${index}.`,
    }));
    const html = renderToStaticMarkup(
      <JourFixeRoom {...props} meeting={{ ...meeting, state: "live", transcript }} />,
    );
    expect(html).toContain("Show earlier messages");
    expect(html).not.toContain("Evidence turn 19.");
    expect(html).toContain("Evidence turn 119.");
    expect(html.indexOf("Evidence turn 21.")).toBeLessThan(html.indexOf("Evidence turn 22."));
  });

  it("keeps cancelled and failed meetings read-only", () => {
    for (const state of ["cancelled", "failed"] as const) {
      const html = renderToStaticMarkup(
        <JourFixeRoom
          {...props}
          meeting={{ ...meeting, state }}
          onComment={async () => {}}
          onMessage={async () => {}}
        />,
      );
      expect(html).not.toContain("Place a comment on the slide");
      expect(html).not.toContain("Message to supervisor");
      expect(html).not.toContain("Confirm 1 to-dos");
    }
  });
});
