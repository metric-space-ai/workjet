import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkjetHeaderContent, WorkjetHeaderSlotContext } from "./WorkjetHeaderSlots";

// Standalone consumers (including native hosts) must retain their controls;
// the shared frame must not briefly duplicate them while its slot mounts.
describe("Workjet header ownership", () => {
  it("retains an accessible surface header outside the shared frame", () => {
    const markup = renderToStaticMarkup(
      <WorkjetHeaderContent aria-label="Project actions">
        <button>New thread</button>
      </WorkjetHeaderContent>,
    );
    expect(markup).toContain('<header aria-label="Project actions">');
    expect(markup).toContain("<button>New thread</button>");
  });

  it("does not mount a second toolbar while the shared slot is being attached", () => {
    const markup = renderToStaticMarkup(
      <WorkjetHeaderSlotContext value={null}>
        <WorkjetHeaderContent>
          <button>New thread</button>
        </WorkjetHeaderContent>
      </WorkjetHeaderSlotContext>,
    );
    expect(markup).toBe("");
  });
});
