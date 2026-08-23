import test from "node:test";
import assert from "node:assert/strict";
import { createDecisionHubPlugin } from "../src/plugin.mjs";
import { OS_EVENT } from "../src/nav.mjs";
import { createSource } from "../src/source.mjs";
import { CONTENT_LINES } from "../src/layout.mjs";

// Der komplette Bedienweg gegen den echten Demo-Datensatz. Bildvergleiche
// zeigen nur, DASS sich etwas aendert — hier wird geprueft, ob sich das
// RICHTIGE aendert.

function harness() {
  const calls = { create: 0, rebuild: 0, image: 0, lastPage: null };
  const sdk = {
    async createStartUpPageContainer(page) { calls.create += 1; calls.lastPage = page; return 0; },
    async rebuildPageContainer(page) { calls.rebuild += 1; calls.lastPage = page; return true; },
    // Der Textaustausch ersetzt den Neuaufbau — die Hilfe muss ihn
    // mitschreiben, sonst prueft sie einen veralteten Bildschirm.
    async textContainerUpgrade(c) {
      const ziel = calls.lastPage?.textObject?.find((t) => t.containerID === c.containerID);
      if (ziel) ziel.content = c.content;
      return true;
    },
    async updateImageRawData() { calls.image += 1; return "success"; },
  };
  const answers = [];
  const source = createSource();
  const original = source.answer.bind(source);
  source.answer = async (payload) => { answers.push(payload); return original(payload); };
  return { sdk, calls, answers, source };
}

const body = (calls) =>
  calls.lastPage.textObject.find((c) => c.containerName === "box-body").content;

test("scrolling down walks through every page of the case", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  const seen = [body(calls)];
  for (let i = 0; i < 4; i += 1) {
    await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
    seen.push(body(calls));
  }
  assert.equal(new Set(seen).size, 5, "five distinct pages: mail, reply, task, notes, audit");
});

test("scrolling up returns to the previous page", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  const first = body(calls);
  await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  const second = body(calls);
  assert.notEqual(first, second);
  await plugin.handleEvent(OS_EVENT.SCROLL_TOP);
  assert.equal(body(calls), first, "scrolling up must land on the page we came from");
});

test("a press opens the long version and scrolling pages through it", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  const kurz = body(calls);
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(plugin.state.level, "detail");
  const langSeite1 = body(calls);
  assert.notEqual(kurz, langSeite1, "the long version must differ from the short one");
  await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  assert.equal(plugin.state.page, 1, "inside the long version a scroll is a page turn");
  assert.notEqual(body(calls), langSeite1);
});

test("the end of the long version continues into the next page", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  await plugin.handleEvent(OS_EVENT.CLICK);          // MAIL lang
  for (let i = 0; i < 6; i += 1) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  assert.equal(plugin.state.level, "rubrik", "back to the short form …");
  assert.ok(plugin.state.sectionIndex >= 1, "… on a later page, not on the same one");
});

test("a double press collapses the long version again", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(plugin.state.level, "detail");
  await plugin.handleEvent(OS_EVENT.DOUBLE_CLICK);
  assert.equal(plugin.state.level, "rubrik");
});

test("past the last page the focus reaches every action icon, then the next case", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  const start = plugin.state.index;
  const focusSeen = new Set();
  for (let i = 0; i < 40 && plugin.state.index === start; i += 1) {
    await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
    if (plugin.state.focusIcon >= 0) focusSeen.add(plugin.state.focusIcon);
  }
  assert.equal(focusSeen.size, 4, "annehmen, ablehnen, korrektur, später");
  assert.notEqual(plugin.state.index, start, "after the icons the next case begins");
  assert.equal(plugin.state.focusIcon, -1, "a fresh case starts on its first page");
});

test("a press on an icon answers, a press on a page never does", async () => {
  const { sdk, answers, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(answers.length, 0, "pressing a page expands, it must not decide");
  await plugin.handleEvent(OS_EVENT.DOUBLE_CLICK);
  while (plugin.state.focusIcon < 0) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(answers.length, 1, "exactly one answer per press");
  assert.equal(answers[0].wert, "annehmen");
});

test("no page ever overflows its container", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  for (let i = 0; i < 25; i += 1) {
    const lines = body(calls).split("\n").length;
    assert.ok(lines <= CONTENT_LINES + 2, `page renders ${lines} lines, budget is ${CONTENT_LINES} + title + rule`);
    await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  }
});

test("head tilt hides and shows the display", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0, tiltOptions: { threshold: 25 } });
  await plugin.start();
  await plugin.handleImu({ x: 0, y: 0, z: 0 });
  await plugin.handleImu({ x: 0, y: -40, z: 0 });
  assert.equal(plugin.visible, false);
  assert.equal(calls.lastPage.textObject.length, 1, "hidden means a blank page");
  await plugin.handleImu({ x: 0, y: 40, z: 0 });
  assert.equal(plugin.visible, true);
  assert.ok(
    calls.lastPage.textObject.some((c) => (c.content || "").trim().length > 0),
    "and the content comes back",
  );
});

test("scrolling up past the first page reaches the previous case", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  // erst zum zweiten Vorgang, dann wieder hoch
  const start = plugin.state.index;
  while (plugin.state.index === start) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  const second = plugin.state.index;
  while (plugin.state.index === second) await plugin.handleEvent(OS_EVENT.SCROLL_TOP);
  assert.equal(plugin.state.index, start, "up must lead back to the case we came from");
});

test("a second press collapses the long version again", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(plugin.state.level, "detail");
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(plugin.state.level, "rubrik", "press must toggle, not only open");
});

test("from the icons a scroll up returns into the pages", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  while (plugin.state.focusIcon < 0) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  while (plugin.state.focusIcon > 0) await plugin.handleEvent(OS_EVENT.SCROLL_TOP);
  await plugin.handleEvent(OS_EVENT.SCROLL_TOP);
  assert.equal(plugin.state.focusIcon, -1, "back in the text …");
  assert.ok(plugin.state.sectionIndex >= 0, "… on a page of the same case");
});

// Der Demo-Modus ist die Schutzschicht, solange die Pipeline nicht
// produktionsreif ist: er darf die Instanz nicht einmal kennen.
test("demo mode cannot reach the instance, even with endpoint and token", async () => {
  const { createSource } = await import("../src/source.mjs");
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({}) }; };
  const demo = createSource({ endpoint: "https://welsch.ctox.dev", token: "t", fetchImpl });
  assert.equal(demo.kind, "fixture", "without live it stays on the fixture");
  const data = await demo.load();
  await demo.answer({ decision: data.decisions[0], wert: "annehmen" });
  assert.equal(calls, 0, "an accepted decision must not send anything in demo mode");
});

test("live mode is only reached deliberately, with an instance", async () => {
  const { isLive } = await import("../src/settings.mjs");
  const instance = { id: "welsch.ctox.dev", baseUrl: "https://welsch.ctox.dev", token: "t" };
  assert.equal(isLive({ mode: "demo", instances: [instance], activeInstanceId: instance.id }), false);
  assert.equal(isLive({ mode: "live", instances: [], activeInstanceId: null }), false, "live without an instance is not live");
  assert.equal(isLive({ mode: "live", instances: [instance], activeInstanceId: instance.id }), true);
});

test("an answered demo case disappears from the queue", async () => {
  const { createSource } = await import("../src/source.mjs");
  const demo = createSource();
  const before = (await demo.load()).decisions;
  await demo.answer({ decision: before[0], wert: "ablehnen" });
  const after = (await demo.load()).decisions;
  assert.equal(after.length, before.length - 1);
});

test("the clock asks how long before it snoozes", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  const vorher = (await source.load()).decisions.length;
  await plugin.act("vertagt");
  assert.ok(body(calls).includes("in 1 Stunde"), "the durations must be offered");
  assert.ok(body(calls).includes("nächste Woche"));
  // Scrollen waehlt, Druck bestaetigt.
  await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  await plugin.handleEvent(OS_EVENT.CLICK);
  const nachher = (await source.load()).decisions.length;
  assert.equal(nachher, vorher, "snoozing keeps the case open");
});

test("a snooze can be abandoned without deciding anything", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  await plugin.act("vertagt");
  assert.ok(body(calls).includes("in 1 Stunde"));
  await plugin.handleEvent(OS_EVENT.DOUBLE_CLICK);
  assert.ok(!body(calls).includes("in 1 Stunde"), "double press closes the question");
});

test("the pencil starts and stops dictation and says so", async () => {
  const { sdk, calls, source } = harness();
  const audio = [];
  sdk.audioControl = async (on, quelle) => { audio.push({ on, quelle }); return true; };
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  await plugin.act("korrektur");
  assert.deepEqual(audio[0], { on: true, quelle: "glasses" }, "the glasses microphone must be switched on");
  assert.ok(body(calls).includes("Diktat"), "and the running dictation must be visible");
  await plugin.act("korrektur");
  assert.equal(audio[1].on, false, "a second press stops the recording");
});

test("a missing microphone is reported, not silently ignored", async () => {
  const { sdk, calls, source } = harness();
  sdk.audioControl = async () => false;
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  await plugin.act("korrektur");
  assert.ok(body(calls).includes("nicht verfügbar"));
});

// Auf der echten Brille loest eine Wischbewegung mehrere Scroll-Ereignisse
// aus. Ohne Sperrzeit blaettert die Anzeige durch mehrere Seiten auf einmal.
test("a burst of scroll events advances exactly one page", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 320 });
  await plugin.start();
  const start = plugin.state.sectionIndex;
  for (let i = 0; i < 5; i += 1) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  assert.equal(plugin.state.sectionIndex, start + 1, "one swipe, one step");
});

test("a deliberate second swipe still works", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 5 });
  await plugin.start();
  const start = plugin.state.sectionIndex;
  await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  await new Promise((r) => setTimeout(r, 20));
  await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  assert.equal(plugin.state.sectionIndex, start + 2, "the lock must not swallow real swipes");
});

test("a press is never swallowed by the scroll lock", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 5000 });
  await plugin.start();
  await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(plugin.state.level, "detail", "pressing must stay responsive");
});

// Kopfneigung liefert das Geraet nicht zuverlaessig. Ersatzgeste: ganz nach
// oben scrollen blendet aus — man merkt, dass man am Anfang angekommen ist.
test("scrolling up past the very top hides the display", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  assert.equal(plugin.visible, true);
  await plugin.handleEvent(OS_EVENT.SCROLL_TOP);   // erste Seite, erster Vorgang
  assert.equal(plugin.visible, false, "the top of the list blanks the display");
  assert.equal(calls.lastPage.textObject.length, 1, "and nothing is drawn");
});

test("the next gesture brings the display back without deciding", async () => {
  const { sdk, answers, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  await plugin.handleEvent(OS_EVENT.SCROLL_TOP);
  assert.equal(plugin.visible, false);
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.equal(plugin.visible, true, "back on screen");
  assert.equal(answers.length, 0, "the reviving press must not decide anything");
});

test("hiding only happens at the very top, not between cases", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  const start = plugin.state.index;
  while (plugin.state.index === start) await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  const zweiter = plugin.state.index;
  while (plugin.state.index === zweiter) await plugin.handleEvent(OS_EVENT.SCROLL_TOP);
  assert.equal(plugin.visible, true, "going back one case must not blank the screen");
});

// Eine liegengebliebene Anzeige im Blickfeld stoert. Nach einstellbarer
// Ruhezeit blendet sie aus und kommt beim naechsten Handgriff zurueck.
test("the display blanks itself after the configured idle time", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0, ruhezeitMs: 40 });
  await plugin.start();
  assert.equal(plugin.visible, true);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(plugin.visible, false, "idle means out of the way");
  plugin.stop();
});

test("every gesture restarts the idle clock", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0, ruhezeitMs: 80 });
  await plugin.start();
  for (let i = 0; i < 3; i += 1) {
    await new Promise((r) => setTimeout(r, 40));
    await plugin.handleEvent(OS_EVENT.SCROLL_BOTTOM);
  }
  assert.equal(plugin.visible, true, "while it is being used it must stay up");
  plugin.stop();
});

test("the idle timeout can be switched off", async () => {
  const { sdk, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0, ruhezeitMs: 0 });
  await plugin.start();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(plugin.visible, true);
  plugin.stop();
});

// Die Kurzfassung ist eine eigenstaendige Zusammenfassung, KEIN
// angeschnittener Originaltext: sie muss ohne Scrollen lesbar sein.
test("every short version fits on one page", async () => {
  const { sectionsOf } = await import("../../kundenpipeline-module/core/sections.mjs");
  const { createSource } = await import("../src/source.mjs");
  const { CONTENT_LINES, PANEL_CHARS } = await import("../src/layout.mjs");
  const daten = await createSource().load();
  for (const dec of daten.decisions) {
    const v = daten.vorgaenge.find((x) => x.id === dec.vorgang_id);
    for (const s of sectionsOf(dec, v, ["mail", "antwort", "aufgabe", "notizen"], PANEL_CHARS)) {
      assert.ok(s.kurz.length <= CONTENT_LINES,
        `"${s.titel}" needs ${s.kurz.length} lines, a page holds ${CONTENT_LINES}`);
    }
  }
});

test("the overview shows the summary, not the cut-off original", async () => {
  const { sdk, calls, source } = harness();
  const plugin = createDecisionHubPlugin({ sdk, source, scrollSperreMs: 0 });
  await plugin.start();
  const kurz = body(calls);
  assert.ok(!kurz.includes("..."), "a summary is never truncated");
  assert.ok(!kurz.startsWith("Guten Morgen"), "and it is not the raw mail either");
  await plugin.handleEvent(OS_EVENT.CLICK);
  assert.ok(body(calls).includes("Guten Morgen"), "the long version carries the original text");
});

test("the long version of a mail describes its attachments", async () => {
  const { sectionsOf } = await import("../../kundenpipeline-module/core/sections.mjs");
  const { createSource } = await import("../src/source.mjs");
  const { PANEL_CHARS } = await import("../src/layout.mjs");
  const daten = await createSource().load();
  const v = daten.vorgaenge[0];
  const mail = sectionsOf(daten.decisions[0], v, ["mail"], PANEL_CHARS)[0];
  const text = mail.zeilen.join(" ");
  assert.ok(text.includes("ANHÄNGE"), "attachments get their own heading");
  assert.ok(text.includes("portal-fehler.png"), "named …");
  assert.ok(text.includes("Bildschirmfoto"), "… and described, not just listed");
  assert.ok(!mail.kurz.join(" ").includes("ANHÄNGE"), "but not in the summary");
});
