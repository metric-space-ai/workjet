/* Geometrie-Wächter + Screenshots für das Inline-Bearbeiten auf den Projektkarten.
   Läuft gegen die R2-Projekte-Fixture (vite dev, Port 5793).
   Prüft je Breite und je offener Rückseite:
   - jedes fokussierbare Element (input, select, button) liegt vollständig im Rect der Rückseite;
   - Rückseite: scrollWidth ≤ clientWidth;
   - ist die Fläche scrollbar, liegt die Knopfzeile im sichtbaren Bereich;
   - Nachbar-Rects vorher/nachher identisch, kein horizontaler Seitenüberlauf.
   Exit-Code ≠ 0 bei Verstoß. */
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");

const output = process.env.INLINE_SHOTS_DIR || "/Volumes/tmp/claude-ia/kimi-inline-shots-2";
const origin = process.env.R2_FIXTURE_ORIGIN || "http://127.0.0.1:5793";
const widths = [1440, 1280, 1024, 768, 420];

const measure = () => {
  const cards = [...document.querySelectorAll("[data-workjet-project-card]")].map((element) => {
    const r = element.getBoundingClientRect();
    return {
      key: element.dataset.workjetProjectCard,
      // Dokument-Koordinaten: scrollIntoView für die Screenshots darf die
      // Nachbar-Rects nicht verstellen.
      x: r.x + window.scrollX,
      y: r.y + window.scrollY,
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

/* Inhalt der offenen Rückseite: alle fokussierbaren Elemente vollständig sichtbar,
   kein horizontaler Überlauf, Knopfzeile im sichtbaren Bereich. */
const backfaceCheck = () => {
  const back = document.querySelector("[data-workjet-project-card-backface]");
  if (!back) return { found: false };
  const rect = back.getBoundingClientRect();
  const box = (r) => ({
    top: Math.round(r.top * 10) / 10,
    right: Math.round(r.right * 10) / 10,
    bottom: Math.round(r.bottom * 10) / 10,
    left: Math.round(r.left * 10) / 10,
  });
  const within = (r) =>
    r.left >= rect.left - 1 &&
    r.right <= rect.right + 1 &&
    r.top >= rect.top - 1 &&
    r.bottom <= rect.bottom + 1;
  // Auch gesperrte Felder zählen: ein abgeschnittenes Bedienelement ist ein
  // Fehler, egal ob es gerade fokussierbar ist.
  const focusable = [...back.querySelectorAll("input, select, button, textarea, a[href]")].filter(
    (element) => element.getClientRects().length > 0 && element.getBoundingClientRect().width > 0,
  );
  const outside = focusable
    .filter((element) => !within(element.getBoundingClientRect()))
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      label:
        element.getAttribute("aria-label") ||
        element.getAttribute("placeholder") ||
        element.textContent.trim().slice(0, 24),
      rect: box(element.getBoundingClientRect()),
    }));
  const actions = back.querySelector("[data-workjet-project-card-config-actions]");
  const scrollable = back.scrollHeight > back.clientHeight + 1;
  const actionsVisible = actions ? within(actions.getBoundingClientRect()) : null;
  return {
    found: true,
    mode: back.dataset.workjetProjectCardBackface,
    backRect: box(rect),
    scrollHeight: back.scrollHeight,
    clientHeight: back.clientHeight,
    scrollWidth: back.scrollWidth,
    clientWidth: back.clientWidth,
    focusableCount: focusable.length,
    outside,
    horizontalOverflow: back.scrollWidth > back.clientWidth + 1,
    scrollable,
    actionsVisible,
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
  const failures = [];
  try {
    for (const width of widths) {
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
      const card = page.locator('[data-workjet-project-card="instance:molecularity"]');
      await card.waitFor();
      const cardCount = await page.locator("[data-workjet-project-card]").count();
      assert.ok(cardCount >= 6, `mindestens 6 Karten, gefunden: ${cardCount}`);

      const shoot = [1440, 420].includes(width);
      const shot = (name) => page.screenshot({ path: `${output}/${width}-${name}.png` });
      const showCard = async () => {
        if (width === 420) await card.evaluate((element) => element.scrollIntoView());
      };
      if (shoot) await shot("geschlossen");
      const before = await page.evaluate(measure);

      const openMenu = async (itemName) => {
        await card.getByRole("button", { name: "Aktionen für molecularity" }).click();
        await page.getByRole("menuitem", { name: itemName }).click();
      };
      const compare = (after, action) => {
        for (const previousCard of before.cards) {
          const next = after.cards.find((candidate) => candidate.key === previousCard.key);
          assert.ok(next, `${action}: Karte ${previousCard.key} fehlt`);
          assert.equal(next.x, previousCard.x, `${action}: x von ${previousCard.key}`);
          assert.equal(next.width, previousCard.width, `${action}: Breite von ${previousCard.key}`);
          if (previousCard.key !== "instance:molecularity")
            assert.equal(next.y, previousCard.y, `${action}: y von ${previousCard.key}`);
        }
        assert.ok(
          after.scrollWidth <= after.viewportWidth,
          `${action}: horizontaler Überlauf (${after.scrollWidth} > ${after.viewportWidth})`,
        );
      };
      const checkBackface = async (action) => {
        const result = await page.evaluate(backfaceCheck);
        assert.ok(result.found, `${action}: Rückseite gefunden`);
        assert.deepEqual(
          result.outside,
          [],
          `${width} ${action}: fokussierbare Elemente außerhalb der Rückseite ` +
            JSON.stringify({ backRect: result.backRect, outside: result.outside }),
        );
        assert.ok(
          !result.horizontalOverflow,
          `${width} ${action}: scrollWidth ${result.scrollWidth} > clientWidth ${result.clientWidth}`,
        );
        if (result.scrollable && result.actionsVisible !== null)
          assert.ok(
            result.actionsVisible,
            `${width} ${action}: Knopfzeile außerhalb des sichtbaren Bereichs`,
          );
        return result;
      };

      // Exit-Bewertung inline
      await openMenu("Exit-Bewertung");
      await page.locator('[data-workjet-project-card-backface="exit"]').waitFor();
      await showCard();
      const afterExit = await page.evaluate(measure);
      compare(afterExit, "exit");
      const exitCheck = await checkBackface("exit");
      if (shoot) await shot("exit-bewertung");
      await page.keyboard.press("Escape");
      await page.locator("[data-workjet-project-card-backface]").waitFor({ state: "detached" });
      compare(await page.evaluate(measure), "escape");

      // Projekt konfigurieren inline
      await openMenu("molecularity konfigurieren");
      await page.locator('[data-workjet-project-card-backface="configure"]').waitFor();
      await page
        .locator('[data-workjet-project-card-config] input[aria-label="Projektname"]')
        .waitFor();
      await showCard();
      const afterConfigure = await page.evaluate(measure);
      compare(afterConfigure, "konfigurieren");
      const configureCheck = await checkBackface("konfigurieren");
      if (shoot || width === 1024) await shot("konfigurieren");
      await page
        .locator('[data-workjet-action="project.card.close:instance:molecularity"]')
        .click();
      await page.locator("[data-workjet-project-card-backface]").waitFor({ state: "detached" });

      assert.deepEqual(errors, [], "keine Konsolenfehler");
      report.widths[width] = {
        cards: cardCount,
        cardWidth: before.cards.find((candidate) => candidate.key === "instance:molecularity")
          ?.width,
        exit: exitCheck,
        konfigurieren: configureCheck,
        scrollWidth: afterExit.scrollWidth,
        viewportWidth: afterExit.viewportWidth,
      };
      await context.close();
    }
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    failures.push(error);
    console.error(String(error.stack || error));
  } finally {
    await browser.close();
  }
  if (failures.length > 0) process.exit(1);
})();
