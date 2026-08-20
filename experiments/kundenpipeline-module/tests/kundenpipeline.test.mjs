import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildView, decisionIcons, decisionLines, tabLabel, hitTest,
  clampScroll, layoutText, typLabel, green,
  DISPLAY_W, DISPLAY_H, BODY_LINES
} from '../core/glasses-renderer.mjs';
import { stripMailBody } from '../index.js';

const demoDecision = {
  typ: 'triage',
  titel: 'REM Capital',
  zeilen_json: ['▸ MAIL', 'Die Lösung funktioniert, jedoch scheint es', 'ein Problem mit dem API Key zu geben.'],
  detail_seiten_json: [{ titel: 'KORREKTUR', zeilen: ['knapper antworten'] }],
  aktionen_json: []
};
const demoVorgang = { id: 'v1', kunde_name: 'REM Capital', quelle_json: { absender: 'j.cakmak@remcapital.de' } };
const vorgangOf = () => demoVorgang;

test('display dimensions match Even Realities spec', () => {
  assert.equal(DISPLAY_W, 576);
  assert.equal(DISPLAY_H, 288);
  assert.ok(BODY_LINES >= 7, `body should hold >= 7 lines, got ${BODY_LINES}`);
});

test('green clamps to 16 levels', () => {
  assert.equal(green(-3), 'rgb(0,0,0)');
  assert.equal(green(15), 'rgb(24,255,70)');
  assert.equal(green(99), 'rgb(24,255,70)');
});

test('view shows all item tabs, active marked, no duplicate header in text', () => {
  const decisions = [demoDecision, { ...demoDecision, titel: 'Müller GmbH' }, { ...demoDecision, titel: 'Bäckerei' }];
  const view = buildView({ decisions, index: 1, focusIcon: -1, scroll: 0, copy: {}, vorgangOf });
  assert.equal(view.tabs.length, 3);
  assert.ok(view.tabs[1].active);
  assert.equal(view.zeilen[0], '▸ MAIL');
  assert.equal(view.focusIcon, -1);
});

test('icon row: accept/reject/correction/snooze, focus marks one', () => {
  const icons = decisionIcons(demoDecision, {});
  assert.deepEqual(icons.map((i) => i.wert), ['annehmen', 'ablehnen', 'korrektur', 'vertagt']);
  const view = buildView({ decisions: [demoDecision], index: 0, focusIcon: 2, scroll: 0, copy: {}, vorgangOf });
  assert.equal(view.focusIcon, 2);
});

test('hitTest resolves tabs and icons', () => {
  const view = buildView({ decisions: [demoDecision, demoDecision], index: 0, focusIcon: -1, scroll: 0, copy: {}, vorgangOf });
  assert.equal(hitTest(view, 30, 10)?.typ, 'tab');
  assert.equal(hitTest(view, 20, 270)?.typ, 'icon');
  assert.equal(hitTest(view, 300, 150), null);
});

test('decisionLines flattens detail pages as scrollable sections', () => {
  const lines = decisionLines(demoDecision);
  assert.ok(lines.length >= 5);
  assert.equal(lines[0], '▸ MAIL');
});

test('tabLabel prefers customer name, hard-trimmed', () => {
  assert.equal(tabLabel(demoDecision, demoVorgang), 'REM');
  assert.equal(tabLabel(demoDecision, { quelle_json: { absender: 'j.cakmak@remcapital.de' } }), 'j.cakmak');
});

test('clampScroll bounds the scroll window', () => {
  assert.equal(clampScroll(-2, 30), 0);
  assert.equal(clampScroll(999, 30), 30 - BODY_LINES);
  assert.equal(clampScroll(3, 4), 0);
});

test('layoutText wraps long text without truncation', () => {
  const lines = layoutText('a'.repeat(30) + ' ' + 'b'.repeat(30) + ' kurz', 44);
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((l) => l.length <= 44));
});

test('stripMailBody removes greeting, signature and footer', () => {
  const body = stripMailBody(
    'Hi Michael,\n\nDie Lösung funktioniert, jedoch scheint es ein Problem mit dem API Key zu geben.\n'
    + 'Netzwerk- oder CORS-Problem beim API-Aufruf.\n\n'
    + 'Mit freundlichen Grüßen\nJill Cakmak\nREM CAPITAL AG | Balanstraße 69b'
  );
  assert.ok(body.startsWith('Die Lösung funktioniert'));
  assert.ok(!body.includes('Mit freundlichen Grüßen'));
  assert.ok(!body.includes('REM CAPITAL AG'));
  assert.ok(!body.includes('Hi Michael'));
});

test('typLabel maps decision types', () => {
  assert.equal(typLabel('mailfreigabe'), 'MAILFREIGABE');
  assert.equal(typLabel('custom'), 'CUSTOM');
});
