import test from 'node:test';
import assert from 'node:assert/strict';
import { navigate, caseNav, OS_EVENT } from '../src/nav.mjs';
import { LEVEL } from '../src/layout.mjs';

const dims = { sections: 3, pages: 4, icons: 5 };

test('one scroll moves to the next rubric, not through text', () => {
  let nav = caseNav();
  nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
  assert.equal(nav.sectionIndex, 1);
  assert.equal(nav.level, LEVEL.RUBRIK, 'stays on the overview level');
});

test('press expands a rubric, scrolling then pages inside it', () => {
  let nav = caseNav();
  nav = navigate(nav, OS_EVENT.CLICK, dims).nav;
  assert.equal(nav.level, LEVEL.DETAIL);
  nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
  assert.equal(nav.page, 1, 'inside a rubric a scroll is a page turn');
});

test('the end of a rubric returns to the overview instead of trapping', () => {
  let nav = { ...caseNav(), level: LEVEL.DETAIL, page: dims.pages - 1 };
  nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
  assert.equal(nav.level, LEVEL.RUBRIK);
});

test('past the last rubric the focus enters the decision icons', () => {
  let nav = { ...caseNav(), sectionIndex: dims.sections - 1 };
  nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
  assert.equal(nav.focusIcon, 0);
});

test('every icon is reachable, and past the last one the next case begins', () => {
  let nav = { ...caseNav(), focusIcon: 0 };
  const seen = new Set([0]);
  for (let i = 0; i < dims.icons - 1; i += 1) {
    nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
    seen.add(nav.focusIcon);
  }
  assert.equal(seen.size, dims.icons);
  const out = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims);
  assert.deepEqual(out.action, { type: 'nextCase' });
  assert.equal(out.nav.focusIcon, -1, 'a fresh case starts in the overview');
});

test('press on an icon activates it; double press leaves the icons', () => {
  const nav = { ...caseNav(), focusIcon: 2 };
  assert.deepEqual(navigate(nav, OS_EVENT.CLICK, dims).action, { type: 'activate', icon: 2 });
  assert.equal(navigate(nav, OS_EVENT.DOUBLE_CLICK, dims).nav.focusIcon, -1);
});

test('double press collapses an expanded rubric', () => {
  const nav = { ...caseNav(), level: LEVEL.DETAIL, page: 2 };
  const out = navigate(nav, OS_EVENT.DOUBLE_CLICK, dims);
  assert.equal(out.nav.level, LEVEL.RUBRIK);
  assert.deepEqual(out.action, { type: 'collapse' });
});

// Die Punkteleiste bildet die Seiten 1:1 ab — ein Punkt je Seite, der aktive
// ist die aktuelle Seite. Alles andere ist eine Luege ueber die Position.
test("the dot rail draws exactly one dot per page", async () => {
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
    assert.equal(dimDots + 1, count, `count=${count}: erwartet ${count} Punkte, gezeichnet ${dimDots + 1}`);
  }
});

// Druck und Doppeldruck kommen als sysEvent; bei CLICK fehlt eventType, weil
// Protobuf die Null weglaesst. Ohne diese Regel loest kein Druck etwas aus.
test("press and double press are decoded from sysEvent", async () => {
  const { osEventFrom } = await import("../src/event-decode.mjs");
  assert.equal(osEventFrom({ sysEvent: { eventSource: 1 } }), 0, "press");
  assert.equal(osEventFrom({ sysEvent: { eventType: 3, eventSource: 1 } }), 3, "double press");
  assert.equal(osEventFrom({ textEvent: { eventType: 2 } }), 2, "scroll stays a text event");
});

test("lifecycle and IMU reports are never gestures", async () => {
  const { osEventFrom } = await import("../src/event-decode.mjs");
  for (const type of [4, 5, 6, 7, 8]) {
    assert.equal(osEventFrom({ sysEvent: { eventType: type, eventSource: 1 } }), null, `type ${type}`);
  }
});

// Protobuf laesst Nullwerte weg — auch den Listenindex: ein Klick auf das
// oberste Element traegt KEIN Indexfeld. Fehlt der Index, ist er 0.
test('a list click on the top item carries no index field and still counts', async () => {
  const { listSelectFrom } = await import('../src/event-decode.mjs');
  assert.deepEqual(listSelectFrom({ listEvent: { containerID: 1 } }),
    { index: 0, name: null, klick: true });
  assert.equal(listSelectFrom({ listEvent: { currentSelectItemIndex: 2 } }).index, 2);
  assert.equal(listSelectFrom({ sysEvent: { eventSource: 1 } }), null);
});
