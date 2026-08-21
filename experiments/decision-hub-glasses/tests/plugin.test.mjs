import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionHubPlugin } from '../src/plugin.mjs';
import { OS_EVENT } from '../src/input.mjs';

function fakeSdk() {
  const calls = { create: 0, upgrade: 0, lastPage: null };
  return {
    calls,
    async createStartUpPageContainer(page) { calls.create += 1; calls.lastPage = page; return 0; },
    async textContainerUpgrade() { calls.upgrade += 1; return true; },
  };
}

function fakeSource(answers = []) {
  const decisions = [{ id: 'd1', vorgang_id: 'v1', typ: 'zuordnung', titel: 'kunde@example.org', zeilen_json: ['Zeile 1', 'Zeile 2'], status: 'offen' }];
  return {
    answers,
    async load() { return { decisions, vorgaenge: [{ id: 'v1', kunde_name: 'Beispielkunde' }] }; },
    async answer(payload) { answers.push(payload); },
  };
}

test('startup creates the page exactly once, then only updates text', async () => {
  const sdk = fakeSdk();
  const plugin = createDecisionHubPlugin({ sdk, source: fakeSource() });
  await plugin.start();
  assert.equal(sdk.calls.create, 1);
  await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  assert.equal(sdk.calls.create, 1, 'the page must not be recreated');
  assert.ok(sdk.calls.upgrade >= 1, 'updates go through textContainerUpgrade');
});

test('a failed page creation is surfaced, never swallowed', async () => {
  const sdk = { async createStartUpPageContainer() { return 2; }, async textContainerUpgrade() { return true; } };
  const errors = [];
  const plugin = createDecisionHubPlugin({ sdk, source: fakeSource(), onError: (e) => errors.push(e) });
  await assert.rejects(() => plugin.start());
  assert.match(errors[0].message, /createStartUpPageContainer failed/);
});

test('pressing a decision icon answers exactly once with that value', async () => {
  const sdk = fakeSdk();
  const answers = [];
  const plugin = createDecisionHubPlugin({ sdk, source: fakeSource(answers) });
  await plugin.start();
  // Scroll onto the icons, then press.
  await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].wert, 'annehmen');
  assert.equal(answers[0].decision.id, 'd1');
});

test('the plugin never answers while the focus is in the text', async () => {
  const sdk = fakeSdk();
  const answers = [];
  const plugin = createDecisionHubPlugin({ sdk, source: fakeSource(answers) });
  await plugin.start();
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(answers.length, 0);
});
