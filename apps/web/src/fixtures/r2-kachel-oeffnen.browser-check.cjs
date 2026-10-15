/* WP-K2: die ganze Projektkachel öffnet das Projekt.
   Läuft gegen die R2-Projekte-Fixture (vite dev; Ursprung per R2_FIXTURE_ORIGIN).
   Prüft in der Kartenansicht:
   - Klick auf Inhaltsfläche, Kopf und KPI-Zeile öffnet (window.openedProjects);
   - Klick auf das ⋯-Menü, „Konfigurieren“ im Menü und „Bewerten“ öffnet nicht;
   - Enter und Leertaste auf der fokussierten Kachel öffnen;
   - ein Ziehen (Zeiger bewegt > 6 px) öffnet nicht;
   - Kachel ohne Website mit GitHub-Quelle zeigt die Social-Preview;
   - Kachel ohne Website und GitHub zeigt Regeltermin und Team statt leerer Fläche.
   Exit-Code ≠ 0 bei Verstoß. */
const { chromium } = require(
  process.env.PLAYWRIGHT_PATH ||
    "/Users/michaelwelsch/.codex/skills/develop-web-game/node_modules/playwright",
);
const assert = require("node:assert/strict");

const origin = process.env.R2_FIXTURE_ORIGIN || "http://127.0.0.1:5793";

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${origin}/r2-projekte-fixture.html?view=karten`, { timeout: 120_000 });
  await page.waitForSelector("[data-workjet-project-card]", { timeout: 120_000 });
  const opened = () => page.evaluate(() => [...window.openedProjects]);
  const reset = () => page.evaluate(() => window.openedProjects.splice(0));
  const card = (key) => page.locator(`[data-workjet-project-card="${key}"]`);

  // Inhaltsfläche, Kopf (neben dem Titel) und KPI-Zeile öffnen.
  const lernwerk = card("instance:lernwerk");
  for (const [key, selector] of [
    ["instance:lernwerk", "[data-workjet-project-card-content]"],
    ["local:workjet", "[data-workjet-project-card-slots]"],
  ]) {
    await reset();
    await card(key)
      .locator(selector)
      .click({ position: { x: 4, y: 4 } });
    assert.deepEqual(await opened(), [key], `Klick auf ${selector}`);
  }
  // Unbekannte Werte fallen weg: nirgends ein „—“ als Platzhalter auf den Kacheln.
  const dashes = await page.evaluate(
    () =>
      [...document.querySelectorAll("[data-workjet-project-card] *")].filter(
        (element) => element.children.length === 0 && element.textContent.trim() === "—",
      ).length,
  );
  assert.equal(dashes, 0, "kein „—“ auf den Kacheln");
  await reset();
  const box = await lernwerk.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 12);
  assert.deepEqual(await opened(), ["instance:lernwerk"], "Klick in den Kopf");

  // Eigene Aktionen öffnen nicht.
  await reset();
  await lernwerk.locator('button[aria-label="Aktionen für Lernwerk"]').click();
  await page.locator('[data-workjet-action="project.configure.gallery:instance:lernwerk"]').click();
  await page.locator('[data-workjet-project-card-backface="configure"]').waitFor();
  assert.deepEqual(await opened(), [], "⋯-Menü und Konfigurieren öffnen nicht");
  await page.keyboard.press("Escape");
  await page.locator("[data-workjet-project-card-backface]").waitFor({ state: "detached" });

  const molecularity = card("instance:molecularity");
  await reset();
  const rate = molecularity.locator('[data-workjet-action^="project.exit_model.rate"]');
  if ((await rate.count()) > 0) {
    await rate.click();
    assert.deepEqual(await opened(), [], "Bewerten öffnet nicht");
    await page.keyboard.press("Escape");
  }

  // Tastatur.
  for (const key of ["Enter", " "]) {
    await reset();
    await lernwerk.focus();
    await page.keyboard.press(key === " " ? "Space" : key);
    assert.deepEqual(await opened(), ["instance:lernwerk"], `Taste ${JSON.stringify(key)}`);
  }

  // Ziehen öffnet nicht.
  await reset();
  const content = await lernwerk.locator("[data-workjet-project-card-content]").boundingBox();
  await page.mouse.move(content.x + 4, content.y + 4);
  await page.mouse.down();
  await page.mouse.move(content.x + 60, content.y + 4, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await opened(), [], "Ziehen öffnet nicht");

  // GitHub-Vorschau und Inhalt statt Leere.
  assert.equal(
    await card("local:workjet")
      .locator('[data-workjet-project-preview="github"] img')
      .getAttribute("src"),
    "https://opengraph.githubassets.com/1/metric-space-ai/workjet",
  );
  // Website ohne gespeicherte Vorschau, GitHub-Quelle: Social-Preview, oder – wenn
  // GitHub das Bild verweigert (privat, Rate-Limit) – still der Inhalt statt Leere.
  const molecularityPreview = molecularity.locator('[data-workjet-project-preview="github"] img');
  if ((await molecularityPreview.count()) > 0)
    assert.equal(
      await molecularityPreview.getAttribute("src"),
      "https://opengraph.githubassets.com/1/metric-space-ai/molecularity",
    );
  else assert.equal(await molecularity.locator("[data-workjet-project-card-content]").count(), 1);
  assert.equal(await lernwerk.locator("[data-workjet-project-preview]").count(), 0);
  const chips = await lernwerk.locator("[data-workjet-project-card-content]").innerText();
  assert.match(chips, /Mi · 09:30/);
  assert.match(chips, /3/);
  assert.match(chips, /1 gestört/);

  await browser.close();
  console.log("r2-kachel-oeffnen: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
