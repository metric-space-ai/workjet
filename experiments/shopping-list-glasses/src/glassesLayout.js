// Brillenseite der Einkaufsliste — Rezept A aus layout-recipes.md.
//
// Eine Seite je ABTEILUNG: links die offenen Artikel dieser Abteilung als
// OS-Liste (die Brille bewegt den Auswahlrahmen selbst, Klick hakt ab),
// rechts der Kontextkasten mit Fortschritt, der Abteilungsname reitet als
// Legendenstreifen im unterbrochenen Rahmen, Punkte zeigen die Position
// unter den Abteilungen. Meta gehoert NIE ins Item-Label — der erste Wurf
// quetschte "OBST Äpfel" in eine Volldisplay-Liste, die unten auslief.
//
// Alles erledigt → Rezept C: eine ruhige, gedimmte Zeile.

import { DEPARTMENTS } from "./state.js";
import { renderLegend, legendWidth, bitmapPayload } from "./paint.js";
import { renderDots } from "./dots.mjs";

const CONTAINER = { LISTE: 1, BOX: 2, LEGEND: 20, DOTS: 21 };

// Rezept-A-Geometrie — aus layout-recipes.md uebernommen, nicht erfunden.
const LISTE = { x: 6, y: 8, w: 170, h: 270 };
const BOX = { x: 202, y: 15, w: 370, h: 268 };
// Punkte MIT LUFT zwischen Liste (endet 176) und Kasten (beginnt 202):
// 198–218 ueberlappte den Kasten — im ersten Render sichtbar.
const DOTS = { x: 179, y: BOX.y + 8, w: 20, h: 144 };
// Die OS-Liste zeichnet ~60–70px je Eintrag und schneidet NICHT am
// Container ab — mehr Eintraege laufen unten aus dem Bild.
const MAX_SICHTBAR = 4;

function zaehlen(page) {
  page.containerTotalNum =
    (page.listObject?.length || 0) +
    (page.textObject?.length || 0) +
    (page.imageObject?.length || 0);
  return page;
}

/** Abteilungen mit offenen Artikeln, in Ladenreihenfolge. */
export function offeneAbteilungen(items) {
  return DEPARTMENTS.filter((d) => items.some((it) => it.dept === d && !it.checked));
}

/**
 * @param {Array} items   alle Artikel {id, text, dept, checked}
 * @param {number} deptPos Position in den offenen Abteilungen (wird geklemmt)
 * @returns {{page, bitmaps, indexMap, deptPos, deptCount, done}}
 */
export function buildGlassesPage(items, deptPos = 0) {
  const offen = offeneAbteilungen(items);

  if (!offen.length) {
    // Rezept C: ruhiger Endzustand, gedimmt, kein Poster. Kein Catcher —
    // der naechste Klick kommt als sysEvent trotzdem an und weckt die App.
    return {
      done: true,
      indexMap: [],
      deptPos: 0,
      deptCount: 0,
      bitmaps: [],
      page: zaehlen({
        containerTotalNum: 0,
        listObject: [],
        imageObject: [],
        textObject: [
          {
            containerID: CONTAINER.BOX,
            containerName: "fertig",
            xPosition: BOX.x,
            yPosition: BOX.y,
            width: BOX.w,
            height: BOX.h,
            borderWidth: 1,
            borderColor: 6,
            borderRadius: 10,
            paddingLength: 10,
            content: "Alles erledigt.\n\nNeue Artikel legst du am Handy an.",
            textColor: 2,
            isEventCapture: 0,
            zOrderIndex: 1,
          },
        ],
      }),
    };
  }

  const pos = Math.max(0, Math.min(deptPos, offen.length - 1));
  const abteilung = offen[pos];
  const artikel = items.filter((it) => it.dept === abteilung && !it.checked);
  const sichtbar = artikel.slice(0, MAX_SICHTBAR);
  const gesamtOffen = items.filter((it) => !it.checked).length;

  const status = [
    `${artikel.length} ${artikel.length === 1 ? "Artikel" : "Artikel"} in dieser Abteilung`,
    `${gesamtOffen} insgesamt offen`,
    "",
    "Klick hakt ab.",
    "Doppelklick: nächste Abteilung.",
    ...(artikel.length > MAX_SICHTBAR
      ? ["", `${artikel.length - MAX_SICHTBAR} weitere erscheinen beim Abhaken.`]
      : []),
  ];

  const legende = renderLegend({
    title: abteilung.toUpperCase(),
    width: legendWidth(abteilung.toUpperCase()),
    height: 20,
  });

  return {
    done: false,
    indexMap: sichtbar.map((it) => it.id),
    deptPos: pos,
    deptCount: offen.length,
    bitmaps: [
      bitmapPayload(legende, CONTAINER.LEGEND),
      bitmapPayload(
        renderDots({ width: DOTS.w, height: DOTS.h, count: offen.length, active: pos }),
        CONTAINER.DOTS,
      ),
    ],
    page: zaehlen({
      containerTotalNum: 0,
      listObject: [
        {
          containerID: CONTAINER.LISTE,
          containerName: "artikel",
          xPosition: LISTE.x,
          yPosition: LISTE.y,
          width: LISTE.w,
          height: LISTE.h,
          // Kein Rahmen um die Liste: der OS-Auswahlrahmen IST die Struktur.
          borderWidth: 0,
          borderRadius: 8,
          paddingLength: 4,
          isEventCapture: 1,
          zOrderIndex: 1,
          itemContainer: {
            itemCount: sichtbar.length,
            itemWidth: 156,
            isItemSelectBorderEn: 1,
            // NUR der Artikelname — die Abteilung steht im Legendenstreifen.
            itemName: sichtbar.map((it) => it.text),
          },
        },
      ],
      textObject: [
        {
          containerID: CONTAINER.BOX,
          containerName: "kontext",
          xPosition: BOX.x,
          yPosition: BOX.y,
          width: BOX.w,
          height: BOX.h,
          borderWidth: 1,
          borderColor: 13,
          borderRadius: 10,
          paddingLength: 10,
          content: status.join("\n"),
          textColor: 3,
          isEventCapture: 0,
          zOrderIndex: 2,
        },
      ],
      imageObject: [
        {
          // Abteilungsname im unterbrochenen Rahmen — nie als Textzeile.
          containerID: CONTAINER.LEGEND,
          containerName: "legend",
          xPosition: BOX.x + 14,
          yPosition: BOX.y - 10,
          width: legende.width,
          height: 20,
          zOrderIndex: 9,
        },
        {
          // Ein Punkt je Abteilung, die aktuelle invertiert.
          containerID: CONTAINER.DOTS,
          containerName: "dots",
          xPosition: DOTS.x,
          yPosition: DOTS.y,
          width: DOTS.w,
          height: DOTS.h,
          zOrderIndex: 4,
        },
      ],
    }),
  };
}

export { DEPARTMENTS };
