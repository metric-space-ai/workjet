import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  buildView,
  decisionIcons,
  decisionLines,
  tabLabel,
  hitTest,
  clampScroll,
  layoutText,
  typLabel,
  green,
  DISPLAY_W,
  DISPLAY_H,
  BODY_LINES,
} from "../core/glasses-renderer.mjs";
import { stripMailBody } from "../index.js";

const demoDecision = {
  typ: "triage",
  titel: "REM Capital",
  zeilen_json: [
    "▸ MAIL",
    "Die Lösung funktioniert, jedoch scheint es",
    "ein Problem mit dem API Key zu geben.",
  ],
  detail_seiten_json: [{ titel: "KORREKTUR", zeilen: ["knapper antworten"] }],
  aktionen_json: [],
};
const demoVorgang = {
  id: "v1",
  kunde_name: "REM Capital",
  quelle_json: { absender: "j.cakmak@remcapital.de" },
};
const vorgangOf = () => demoVorgang;

NodeTest("display dimensions match Even Realities spec", () => {
  NodeAssert.equal(DISPLAY_W, 576);
  NodeAssert.equal(DISPLAY_H, 288);
  NodeAssert.ok(BODY_LINES >= 7, `body should hold >= 7 lines, got ${BODY_LINES}`);
});

NodeTest("green clamps to 16 levels", () => {
  NodeAssert.equal(green(-3), "rgb(0,0,0)");
  NodeAssert.equal(green(15), "rgb(24,255,70)");
  NodeAssert.equal(green(99), "rgb(24,255,70)");
});

NodeTest("view shows all item tabs, active marked, no duplicate header in text", () => {
  const decisions = [
    demoDecision,
    { ...demoDecision, titel: "Müller GmbH" },
    { ...demoDecision, titel: "Bäckerei" },
  ];
  const view = buildView({ decisions, index: 1, focusIcon: -1, scroll: 0, copy: {}, vorgangOf });
  NodeAssert.equal(view.tabs.length, 3);
  NodeAssert.ok(view.tabs[1].active);
  NodeAssert.equal(view.zeilen[0], "▸ MAIL");
  NodeAssert.equal(view.focusIcon, -1);
});

NodeTest("icon row: accept/reject/correction/snooze, focus marks one", () => {
  const icons = decisionIcons(demoDecision, {});
  NodeAssert.deepEqual(
    icons.map((i) => i.wert),
    ["annehmen", "ablehnen", "korrektur", "vertagt"],
  );
  const view = buildView({
    decisions: [demoDecision],
    index: 0,
    focusIcon: 2,
    scroll: 0,
    copy: {},
    vorgangOf,
  });
  NodeAssert.equal(view.focusIcon, 2);
});

NodeTest("hitTest resolves tabs and icons", () => {
  const view = buildView({
    decisions: [demoDecision, demoDecision],
    index: 0,
    focusIcon: -1,
    scroll: 0,
    copy: {},
    vorgangOf,
  });
  NodeAssert.equal(hitTest(view, 30, 10)?.typ, "tab");
  NodeAssert.equal(hitTest(view, 20, 270)?.typ, "icon");
  NodeAssert.equal(hitTest(view, 300, 150), null);
});

NodeTest("decisionLines flattens detail pages as scrollable sections", () => {
  const lines = decisionLines(demoDecision);
  NodeAssert.ok(lines.length >= 5);
  NodeAssert.equal(lines[0], "▸ MAIL");
});

NodeTest("tabLabel prefers customer name, hard-trimmed", () => {
  NodeAssert.equal(tabLabel(demoDecision, demoVorgang), "REM");
  NodeAssert.equal(
    tabLabel(demoDecision, { quelle_json: { absender: "j.cakmak@remcapital.de" } }),
    "j.cakmak",
  );
});

NodeTest("clampScroll bounds the scroll window", () => {
  NodeAssert.equal(clampScroll(-2, 30), 0);
  NodeAssert.equal(clampScroll(999, 30), 30 - BODY_LINES);
  NodeAssert.equal(clampScroll(3, 4), 0);
});

NodeTest("layoutText wraps long text without truncation", () => {
  const lines = layoutText("a".repeat(30) + " " + "b".repeat(30) + " kurz", 44);
  NodeAssert.ok(lines.length >= 2);
  NodeAssert.ok(lines.every((l) => l.length <= 44));
});

NodeTest("stripMailBody removes greeting, signature and footer", () => {
  const body = stripMailBody(
    "Hi Michael,\n\nDie Lösung funktioniert, jedoch scheint es ein Problem mit dem API Key zu geben.\n" +
      "Netzwerk- oder CORS-Problem beim API-Aufruf.\n\n" +
      "Mit freundlichen Grüßen\nJill Cakmak\nREM CAPITAL AG | Balanstraße 69b",
  );
  NodeAssert.ok(body.startsWith("Die Lösung funktioniert"));
  NodeAssert.ok(!body.includes("Mit freundlichen Grüßen"));
  NodeAssert.ok(!body.includes("REM CAPITAL AG"));
  NodeAssert.ok(!body.includes("Hi Michael"));
});

NodeTest("typLabel maps decision types", () => {
  NodeAssert.equal(typLabel("mailfreigabe"), "MAILFREIGABE");
  NodeAssert.equal(typLabel("custom"), "CUSTOM");
});
