import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView, BODY_LINES } from '../../kundenpipeline-module/core/glasses-renderer.mjs';
import { viewToPageContainer, tabsLine, iconsLine, bodyText, CONTAINER } from '../src/view-to-containers.mjs';
import { reduce, OS_EVENT } from '../src/input.mjs';

const vorgang = {
  id: 'v1',
  kunde_name: 'Beispielkunde',
  quelle_json: { absender: 'kunde@example.org', betreff: 'Angebot', body_clean: 'Bitte um ein Angebot fuer einen Wartungsvertrag ueber zwoelf Monate.' },
};
const decision = { id: 'd1', vorgang_id: 'v1', typ: 'zuordnung', titel: 'kunde@example.org', zeilen_json: Array.from({ length: 30 }, (_, i) => `Zeile ${i + 1}`), status: 'offen' };

function view(overrides = {}) {
  return buildView({
    decisions: [decision, { ...decision, id: 'd2' }],
    index: 0, focusIcon: -1, scroll: 0,
    vorgangOf: () => vorgang, copy: {},
    ...overrides,
  });
}

test('page fits the SDK container budget', () => {
  const page = viewToPageContainer(view());
  assert.equal(page.containerTotalNum, 3);
  assert.ok(page.textObject.length <= 8, 'max 8 text containers');
  assert.ok(page.containerTotalNum >= 1 && page.containerTotalNum <= 12);
});

test('exactly one container captures input', () => {
  const page = viewToPageContainer(view());
  const capturing = page.textObject.filter((c) => c.isEventCapture === 1);
  assert.equal(capturing.length, 1);
  assert.equal(capturing[0].containerID, CONTAINER.ICONS);
});

test('containers stay inside the 576x288 display', () => {
  for (const c of viewToPageContainer(view()).textObject) {
    assert.ok(c.xPosition + c.width <= 576, `${c.containerName} exceeds width`);
    assert.ok(c.yPosition + c.height <= 288, `${c.containerName} exceeds height`);
  }
});

test('body shows exactly the window of lines, never more', () => {
  const lines = bodyText(view()).split('\n');
  assert.equal(lines.length, BODY_LINES);
  assert.equal(lines[0], 'Zeile 1');
});

test('the active tab survives truncation', () => {
  const tabs = Array.from({ length: 12 }, (_, i) => ({ label: `Kunde${i}`, active: i === 7 }));
  const line = tabsLine(tabs);
  assert.ok(line.length <= 52);
  assert.ok(line.includes('[Kunde7]'), `active tab missing in: ${line}`);
});

test('scrolling past the text moves focus onto the icons, then to the next item', () => {
  const v = view();
  const dims = { lineCount: v.zeilen.length, iconCount: v.icons.length, itemCount: 2 };
  let state = { scroll: 0, focusIcon: -1, index: 0 };
  const seen = { reachedIcons: false, visitedEveryIcon: new Set() };
  let steps = 0;
  // One continuous flow: text -> every icon -> next item. Stop at the item
  // change instead of a fixed count, which would silently wrap around.
  while (state.index === 0 && steps < 40) {
    state = reduce(state, OS_EVENT.SCROLL_BOTTOM, dims).state;
    steps += 1;
    if (state.focusIcon >= 0) {
      seen.reachedIcons = true;
      seen.visitedEveryIcon.add(state.focusIcon);
    }
  }
  assert.ok(seen.reachedIcons, 'focus must pass through the decision icons');
  assert.equal(seen.visitedEveryIcon.size, dims.iconCount, 'every icon must be reachable');
  assert.equal(state.index, 1, 'past the last icon the next item begins');
  assert.equal(state.focusIcon, -1, 'a fresh item starts in the text');
  assert.equal(state.scroll, 0);
});

test('press activates the focused icon, double press returns to the text', () => {
  const v = view();
  const dims = { lineCount: v.zeilen.length, iconCount: v.icons.length, itemCount: 2 };
  let state = { scroll: 0, focusIcon: 1, index: 0 };
  const pressed = reduce(state, OS_EVENT.CLICK, dims);
  assert.deepEqual(pressed.action, { type: 'activate', icon: 1 });
  const back = reduce(pressed.state, OS_EVENT.DOUBLE_CLICK, dims);
  assert.equal(back.state.focusIcon, -1);
  assert.deepEqual(back.action, { type: 'back' });
});

test('press in the text does nothing', () => {
  const v = view();
  const dims = { lineCount: v.zeilen.length, iconCount: v.icons.length, itemCount: 2 };
  const out = reduce({ scroll: 0, focusIcon: -1, index: 0 }, OS_EVENT.CLICK, dims);
  assert.equal(out.action, null);
});

test('focused action is marked and all four decisions are offered', () => {
  const line = iconsLine({ ...view(), focusIcon: 0 });
  // Die Brillenschrift hat kein ✓/✔/✗/✘/✎/◷ (am Simulator verifiziert),
  // deshalb Woerter plus das vorhandene Caret ▶.
  assert.ok(line.includes('▶OK'), `focus caret missing in: ${line}`);
  for (const label of ['OK', 'NEIN', 'KORREKTUR', 'SPÄTER']) {
    assert.ok(line.includes(label), `missing ${label}`);
  }
  for (const missing of ['✓', '✔', '✗', '✘', '✎', '◷']) {
    assert.ok(!line.includes(missing), `${missing} does not exist on the device font`);
  }
});

test('text budget stays within the documented full-screen limit', () => {
  const page = viewToPageContainer(view());
  const total = page.textObject.reduce((sum, c) => sum + c.content.length, 0);
  assert.ok(total <= 1000, `startup limit is 1000 chars, got ${total}`);
});
