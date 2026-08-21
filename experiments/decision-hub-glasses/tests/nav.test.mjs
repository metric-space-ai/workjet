import test from 'node:test';
import assert from 'node:assert/strict';
import { navigate, initialNav, OS_EVENT } from '../src/nav.mjs';
import { LEVEL } from '../src/layout.mjs';

const dims = { sections: 3, pages: 4, icons: 5 };

test('one scroll moves to the next rubric, not through text', () => {
  let nav = initialNav();
  nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
  assert.equal(nav.sectionIndex, 1);
  assert.equal(nav.level, LEVEL.RUBRIK, 'stays on the overview level');
});

test('press expands a rubric, scrolling then pages inside it', () => {
  let nav = initialNav();
  nav = navigate(nav, OS_EVENT.CLICK, dims).nav;
  assert.equal(nav.level, LEVEL.DETAIL);
  nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
  assert.equal(nav.page, 1, 'inside a rubric a scroll is a page turn');
});

test('the end of a rubric returns to the overview instead of trapping', () => {
  let nav = { ...initialNav(), level: LEVEL.DETAIL, page: dims.pages - 1 };
  nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
  assert.equal(nav.level, LEVEL.RUBRIK);
});

test('past the last rubric the focus enters the decision icons', () => {
  let nav = { ...initialNav(), sectionIndex: dims.sections - 1 };
  nav = navigate(nav, OS_EVENT.SCROLL_BOTTOM, dims).nav;
  assert.equal(nav.focusIcon, 0);
});

test('every icon is reachable, and past the last one the next case begins', () => {
  let nav = { ...initialNav(), focusIcon: 0 };
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
  const nav = { ...initialNav(), focusIcon: 2 };
  assert.deepEqual(navigate(nav, OS_EVENT.CLICK, dims).action, { type: 'activate', icon: 2 });
  assert.equal(navigate(nav, OS_EVENT.DOUBLE_CLICK, dims).nav.focusIcon, -1);
});

test('double press collapses an expanded rubric', () => {
  const nav = { ...initialNav(), level: LEVEL.DETAIL, page: 2 };
  const out = navigate(nav, OS_EVENT.DOUBLE_CLICK, dims);
  assert.equal(out.nav.level, LEVEL.RUBRIK);
  assert.deepEqual(out.action, { type: 'collapse' });
});
