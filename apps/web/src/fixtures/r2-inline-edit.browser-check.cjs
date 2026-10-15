/* Geometrie-Wächter + Screenshots für das Inline-Bearbeiten auf den Projektkarten.
   Läuft gegen die R2-Projekte-Fixture (vite dev, Port 5793).
   Prüft je Breite und je offener Rückseite:
   - jedes fokussierbare Element (input, select, button) liegt vollständig im Rect der Rückseite;
   - Rückseite: scrollWidth ≤ clientWidth;
   - ist die Fläche scrollbar, liegt die Knopfzeile im sichtbaren Bereich;
   - Nachbar-Rects vorher/nachher identisch, kein horizontaler Seitenüberlauf.
   Zusätzlich Kontrast der Exit-Stempel zwischen Stempeltext und Stempelgrund
   (berechnete Farben, über hellem wie dunklem Untergrund komponiert) ≥ 4,5:1,
   in dunklem und hellem Modus. Seit WP-K1 gibt es nur Wertstempel: ein
   „Nicht bewertet“-Stempel ist ein Verstoß.
   Exit-Code ≠ 0 bei Verstoß. */
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");

const output = process.env.INLINE_SHOTS_DIR || "/Volumes/tmp/claude-ia/kimi-inline-shots-3";
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

/* Kontrast der Exit-Stempel: berechnete Text- und Grundfarbe, jeweils über
   hellem (weiß) und dunklem (schwarz) Vorschau-Untergrund komponiert, weil die
   Vorschau unter dem halbtransparenten Grund durchscheint. WCAG-Kontrast der
   beiden wahrgenommenen Farben. */
const stampContrast = () => {
  // oklab/oklch (CSS Color 4) nach sRGB: Canvas-fillStyle verwirft solche
  // Farben hier, darum eigene Umrechnung (Björn Ottosson, sRGB-Matrix).
  const oklabToSrgb = (L, a, b) => {
    const l3 = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m3 = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s3 = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    const encode = (v) => {
      v = Math.min(1, Math.max(0, v));
      return (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
    };
    return {
      r: encode(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
      g: encode(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
      b: encode(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
    };
  };
  const number = (raw) =>
    raw === "none" ? 0 : raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw);
  const parse = (css) => {
    const ok = css.match(
      /^(oklab|oklch)\(\s*([\d.]+%?|none)\s+([\d.]+%?|none)\s+([\d.]+(?:deg)?|none)(?:\s*\/\s*([\d.]+%?|none))?\s*\)$/,
    );
    if (ok) {
      const L = number(ok[2]);
      let a;
      let b;
      if (ok[1] === "oklch") {
        const hue = ok[4] === "none" ? 0 : parseFloat(ok[4]) * (Math.PI / 180);
        a = number(ok[3]) * Math.cos(hue);
        b = number(ok[3]) * Math.sin(hue);
      } else {
        a = number(ok[3]);
        b = number(ok[4]);
      }
      return { ...oklabToSrgb(L, a, b), a: ok[5] === undefined ? 1 : number(ok[5]) };
    }
    const context = document.createElement("canvas").getContext("2d");
    context.fillStyle = "#000000";
    context.fillStyle = css;
    const value = context.fillStyle;
    if (value.startsWith("#")) {
      const hex = value.slice(1);
      const packed = parseInt(hex, 16);
      if (hex.length === 6)
        return { r: (packed >> 16) & 255, g: (packed >> 8) & 255, b: packed & 255, a: 1 };
      return {
        r: (packed >> 24) & 255,
        g: (packed >> 16) & 255,
        b: (packed >> 8) & 255,
        a: (packed & 255) / 255,
      };
    }
    const parts = value.match(/[\d.]+/g).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const channel = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
    return {
      r: channel(top.r, bottom.r),
      g: channel(top.g, bottom.g),
      b: channel(top.b, bottom.b),
      a,
    };
  };
  const luminance = ({ r, g, b }) => {
    const linear = (v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const ratio = (first, second) => {
    const high = Math.max(first, second);
    const low = Math.min(first, second);
    return (high + 0.05) / (low + 0.05);
  };
  return [...document.querySelectorAll("[data-workjet-exit-model-stamp]")].map((element) => {
    const style = getComputedStyle(element);
    const text = parse(style.color);
    const ground = parse(style.backgroundColor);
    const perBackdrop = {};
    for (const [name, backdrop] of [
      ["hell", { r: 255, g: 255, b: 255, a: 1 }],
      ["dunkel", { r: 0, g: 0, b: 0, a: 1 }],
    ]) {
      const seenGround = over(ground, backdrop);
      const seenText = over(text, seenGround);
      perBackdrop[name] = Math.round(ratio(luminance(seenText), luminance(seenGround)) * 100) / 100;
    }
    return {
      text: element.textContent.trim(),
      status: element.dataset.workjetExitModelStatus,
      color: style.color,
      background: style.backgroundColor,
      kontrast: perBackdrop,
    };
  });
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

      const compare = (after, action) => {
        for (const previousCard of before.cards) {
          const next = after.cards.find((candidate) => candidate.key === previousCard.key);
          assert.ok(next, `${action}: Karte ${previousCard.key} fehlt`);
          assert.equal(next.x, previousCard.x, `${action}: x von ${previousCard.key}`);
          assert.equal(next.width, previousCard.width, `${action}: Breite von ${previousCard.key}`);
          // Ohne Vorschaubild hat die Karte keine Vorschaufläche (WP-K1); die
          // Rückseite braucht dann Platz, und nur Karten in tieferen Reihen rücken.
          const target = before.cards.find((c) => c.key === "instance:molecularity");
          if (previousCard.key !== "instance:molecularity" && previousCard.y <= (target?.y ?? 0))
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
      // Das Menü kennt keine Rückseiten-Einträge mehr: der Wertstempel öffnet die
      // Bewertung, die KPI-Zeile die Konfiguration (#561).
      await card.locator('[data-workjet-action="project.exit_model.stamp"]').click();
      await page.locator('[data-workjet-project-card-backface="exit"]').waitFor();
      await showCard();
      const afterExit = await page.evaluate(measure);
      compare(afterExit, "exit");
      const exitCheck = await checkBackface("exit");
      if (shoot) await shot("exit-bewertung");
      await page.keyboard.press("Escape");
      await page.locator("[data-workjet-project-card-backface]").waitFor({ state: "detached" });
      compare(await page.evaluate(measure), "escape");

      // Projekt konfigurieren inline (seit WP-K2 im ⋯-Menü: die ganze Kachel öffnet das Projekt)
      await card.locator('button[aria-label="Aktionen für molecularity"]').click();
      await page
        .locator('[data-workjet-action="project.configure.gallery:instance:molecularity"]')
        .click();
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

    // Stempel-Kontrast in beiden Modi: Text gegen Stempelgrund, über hellem
    // wie dunklem Vorschau-Untergrund, Verhältnis ≥ 4,5:1 (WCAG AA).
    report.stempelKontrast = {};
    for (const scheme of ["dark", "light"]) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: "de-DE",
        colorScheme: scheme,
      });
      const page = await context.newPage();
      await page.goto(`${origin}/r2-projekte-fixture.html?view=karten`, {
        waitUntil: "networkidle",
      });
      await page.locator("[data-workjet-project-gallery-grid]").waitFor();
      const stamps = await page.evaluate(stampContrast);
      const unbewertet = stamps.filter((stamp) => stamp.text === "Nicht bewertet");
      const bewertet = stamps.filter((stamp) => stamp.text !== "Nicht bewertet");
      assert.ok(bewertet.length > 0, `${scheme}: Wertstempel fehlt`);
      assert.equal(unbewertet.length, 0, `${scheme}: „Nicht bewertet“-Stempel ist zurück`);
      for (const stamp of stamps) {
        for (const backdrop of ["hell", "dunkel"]) {
          assert.ok(
            stamp.kontrast[backdrop] >= 4.5,
            `${scheme}: Stempel „${stamp.text}“ auf ${backdrop}em Untergrund ` +
              `Kontrast ${stamp.kontrast[backdrop]} < 4,5 ` +
              `(Text ${stamp.color}, Grund ${stamp.background})`,
          );
        }
      }
      if (scheme === "light")
        await page.screenshot({ path: `${output}/1440-geschlossen-hell.png` });
      report.stempelKontrast[scheme] = {
        wert: bewertet[0],
        anzahl: stamps.length,
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
