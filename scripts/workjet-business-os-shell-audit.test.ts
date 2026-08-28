import { describe, expect, it } from "@effect/vitest";

import {
  createDiscoveredAppStates,
  createReviewBatches,
  selectLocalBusinessOsTarget,
} from "./workjet-business-os-shell-audit.ts";

describe("Business OS shell audit safety", () => {
  it("accepts only one explicitly local CTOX shell", () => {
    expect(
      selectLocalBusinessOsTarget([
        {
          id: "local",
          type: "page",
          title: "Desktop (CTOX Local Instance)",
          url: "http://127.0.0.1:50941/business-os/",
          webSocketDebuggerUrl: "ws://local",
        },
      ]),
    ).toMatchObject({ id: "local" });
    expect(() =>
      selectLocalBusinessOsTarget([
        {
          id: "customer",
          type: "page",
          title: "Desktop (Customer)",
          url: "https://customer.example/business-os/",
          webSocketDebuggerUrl: "ws://customer",
        },
      ]),
    ).toThrow();
  });

  it("never gives a reviewer more than four screenshots", () => {
    const batches = createReviewBatches(Array.from({ length: 19 }, (_, index) => index));
    expect(batches.flat()).toHaveLength(19);
    expect(Math.max(...batches.map((batch) => batch.length))).toBe(4);
  });

  it("adds every discovered desktop app exactly once without duplicating pinned apps", () => {
    expect(
      createDiscoveredAppStates(["Tickets", "Mail", "Mail", "  Browser  "]).map(
        (state) => state.action,
      ),
    ).toEqual(["app:Browser", "app:Mail"]);
  });
});
