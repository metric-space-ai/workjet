/* Geometrie-Wächter + Screenshots für das Inline-Bearbeiten auf den Projektkarten.
   Läuft gegen die R2-Projekte-Fixture (vite dev, Port 5793). */
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");

const output = process.env.INLINE_SHOTS_DIR || "/Volumes/tmp/claude-ia/kimi-inline-shots";
const origin = process.env.R2_FIXTURE_ORIGIN || "http://127.0.0.1:5793";

const measure = () => {
  const cards = [...document.querySelectorAll("[data-workjet-project-card]")].map((element) => {
    const r = element.getBoundingClientRect();
    return {
      key: element.dataset.workjetProjectCard,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
    };
  });
  return {
    cards,
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  };
};

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const report = { widths: {} };
  try {
    for (const width of [1440, 420]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        locale: "de-DE",
        colorScheme: "dark",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(`${origin}/r2-projekte-fixture.html?view=karten`, {
        waitUntil: "networkidle",
      });
      await page.locator("[data-workjet-project-gallery-grid]").waitFor();
      await page.locator('[data-workjet-project-card="instance:molecularity"]').waitFor();
      const cardCount = await page.locator("[data-workjet-project-card]").count();
      assert.ok(cardCount >= 6, `mindestens 6 Karten, gefunden: ${cardCount}`);

      const shot = (name) => page.screenshot({ path: `${output}/${width}-${name}.png` });
      await shot("geschlossen");
      const before = await page.evaluate(measure);

      const openMenu = async (itemName) => {
        const card = page.locator('[data-workjet-project-card="instance:molecularity"]');
        await card.getByRole("button", { name: "Aktionen für molecularity" }).click();
        await page.getByRole("menuitem", { name: itemName }).click();
      };
      const compare = (after, action) => {
        for (const previousCard of before.cards) {
          const next = after.cards.find((candidate) => candidate.key === previousCard.key);
          assert.ok(next, `${action}: Karte ${previousCard.key} fehlt`);
          if (previousCard.key === "instance:molecularity") {
            assert.equal(next.x, previousCard.x, `${action}: x der bearbeiteten Karte`);
            assert.equal(next.width, previousCard.width, `${action}: Breite der Karte`);
          } else {
            assert.equal(next.x, previousCard.x, `${action}: x von ${previousCard.key}`);
            assert.equal(next.y, previousCard.y, `${action}: y von ${previousCard.key}`);
            assert.equal(
              next.width,
              previousCard.width,
              `${action}: Breite von ${previousCard.key}`,
            );
          }
        }
        assert.ok(
          after.scrollWidth <= after.viewportWidth,
          `${action}: horizontaler Überlauf (${after.scrollWidth} > ${after.viewportWidth})`,
        );
      };

      // Exit-Bewertung inline
      await openMenu("Exit-Bewertung");
      await page.locator('[data-workjet-project-card-backface="exit"]').waitFor();
      const afterExit = await page.evaluate(measure);
      compare(afterExit, "exit");
      await shot("exit-bewertung");
      await page.keyboard.press("Escape");
      await page.locator("[data-workjet-project-card-backface]").waitFor({ state: "detached" });
      const afterEscape = await page.evaluate(measure);
      compare(afterEscape, "escape");

      // Projekt konfigurieren inline
      await openMenu("molecularity konfigurieren");
      await page.locator('[data-workjet-project-card-backface="configure"]').waitFor();
      await page
        .locator('[data-workjet-project-card-config] input[aria-label="Projektname"]')
        .waitFor();
      const afterConfigure = await page.evaluate(measure);
      compare(afterConfigure, "konfigurieren");
      await shot("konfigurieren");
      await page
        .locator('[data-workjet-action="project.card.close:instance:molecularity"]')
        .click();
      await page.locator("[data-workjet-project-card-backface]").waitFor({ state: "detached" });

      assert.deepEqual(errors, [], "keine Konsolenfehler");
      report.widths[width] = {
        cards: cardCount,
        before: before.cards,
        exit: afterExit.cards,
        konfigurieren: afterConfigure.cards,
        scrollWidth: afterExit.scrollWidth,
        viewportWidth: afterExit.viewportWidth,
      };
      await context.close();
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
