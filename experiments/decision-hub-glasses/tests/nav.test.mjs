import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { navigate, initialNav, OS_EVENT } from "../src/nav.mjs";
import { LEVEL } from "../src/layout.mjs";

const dims = { sections: 3, pages: 4, icons: 5 };

NodeTest("one scroll moves to the next rubric, not through text", () => {
  let nav = initialNav();
  nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
  NodeAssert.equal(nav.sectionIndex, 1);
  NodeAssert.equal(nav.level, LEVEL.RUBRIK, "stays on the overview level");
});

NodeTest("press expands a rubric, scrolling then pages inside it", () => {
  let nav = initialNav();
  nav = navigate(nav, OS_EVENT.CLICK, dims).nav;
  NodeAssert.equal(nav.level, LEVEL.DETAIL);
  nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
  NodeAssert.equal(nav.page, 1, "inside a rubric a scroll is a page turn");
});

NodeTest("the end of a rubric returns to the overview instead of trapping", () => {
  let nav = { ...initialNav(), level: LEVEL.DETAIL, page: dims.pages - 1 };
  nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
  NodeAssert.equal(nav.level, LEVEL.RUBRIK);
});

NodeTest("past the last rubric the focus enters the decision icons", () => {
  let nav = { ...initialNav(), sectionIndex: dims.sections - 1 };
  nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
  NodeAssert.equal(nav.focusIcon, 0);
});

NodeTest("every icon is reachable, and past the last one the next case begins", () => {
  let nav = { ...initialNav(), focusIcon: 0 };
  const seen = new Set([0]);
  for (let i = 0; i < dims.icons - 1; i += 1) {
    nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
    seen.add(nav.focusIcon);
  }
  NodeAssert.equal(seen.size, dims.icons);
  const out = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims);
  NodeAssert.deepEqual(out.action, { type: "nextCase" });
  NodeAssert.equal(out.nav.focusIcon, -1, "a fresh case starts in the overview");
});

NodeTest("press on an icon activates it; double press leaves the icons", () => {
  const nav = { ...initialNav(), focusIcon: 2 };
  NodeAssert.deepEqual(navigate(nav, OS_EVENT.CLICK, dims).action, { type: "activate", icon: 2 });
  NodeAssert.equal(navigate(nav, OS_EVENT.DOUBLE_CLICK, dims).nav.focusIcon, -1);
});

NodeTest("double press collapses an expanded rubric", () => {
  const nav = { ...initialNav(), level: LEVEL.DETAIL, page: 2 };
  const out = navigate(nav, OS_EVENT.DOUBLE_CLICK, dims);
  NodeAssert.equal(out.nav.level, LEVEL.RUBRIK);
  NodeAssert.deepEqual(out.action, { type: "collapse" });
});

// Die Punkteleiste bildet die Seiten 1:1 ab — ein Punkt je Seite, der aktive
// ist die aktuelle Seite. Alles andere ist eine Luege ueber die Position.
NodeTest("the dot rail draws exactly one dot per page", async () => {
  const { renderDots } = await import("../src/dots.mjs");
  for (const count of [1, 2, 5, 9]) {
    const bmp = renderDots({ width: 8, height: 140, count, active: 0 });
    // helle Pixel (15) = aktiver Punkt, gedaempfte (6) = die uebrigen
    const dim = new Set();
    for (let y = 0; y < bmp.height; y += 1) {
      for (let x = 0; x < bmp.width; x += 1) {
        if (bmp.px[y * bmp.width + x] === 6) dim.add(y);
      }
    }
    // jeder gedaempfte Punkt ist 2 px hoch
    const dimDots = Math.round(dim.size / 2);
    NodeAssert.equal(
      dimDots + 1,
      count,
      `count=${count}: erwartet ${count} Punkte, gezeichnet ${dimDots + 1}`,
    );
  }
});

// Druck und Doppeldruck kommen als sysEvent; bei CLICK fehlt eventType, weil
// Protobuf die Null weglaesst. Ohne diese Regel loest kein Druck etwas aus.
NodeTest("press and double press are decoded from sysEvent", async () => {
  const { osEventFrom } = await import("../src/event-decode.mjs");
  NodeAssert.equal(osEventFrom({ sysEvent: { eventSource: 1 } }), 0, "press");
  NodeAssert.equal(osEventFrom({ sysEvent: { eventType: 3, eventSource: 1 } }), 3, "double press");
  NodeAssert.equal(osEventFrom({ textEvent: { eventType: 2 } }), 2, "scroll stays a text event");
});

NodeTest("lifecycle and IMU reports are never gestures", async () => {
  const { osEventFrom } = await import("../src/event-decode.mjs");
  for (const type of [4, 5, 6, 7, 8]) {
    NodeAssert.equal(
      osEventFrom({ sysEvent: { eventType: type, eventSource: 1 } }),
      null,
      `type ${type}`,
    );
  }
});
