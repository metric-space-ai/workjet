// Even-Hub-Ausgabe für dasselbe Ansichtsmodell, das die Desktop-Vorschau malt.
//
// Die Brille rendert KEIN HTML: sie setzt die Seite aus SDK-Containern
// zusammen, die per absoluter Pixelposition liegen (max. 8 Text-, 4 Bild-
// Container, zusammen 1..12). Deshalb wird hier nur der Malschritt ersetzt —
// `buildView()` aus dem Renderer bleibt die einzige Quelle der Ansicht.
//
// Layout identisch zur Vorschau: Reiterzeile oben, 10 Textzeilen, Icon-Zeile
// unten. Genau ein Container trägt isEventCapture = 1 und empfängt Eingaben.

import {
  DISPLAY_W,
  DISPLAY_H,
  BODY_LINES,
  clampScroll,
} from "../../kundenpipeline-module/core/glasses-renderer.mjs";

const PAD_X = 14;
// Gemessen am Simulator: 26 px Zeilenabstand, Textgroesse nicht einstellbar.
const TAB_H = 25;
const ICON_H = 33;
const LINE_H = 26;

// 0..4 Helligkeitsstufen des Text-Containers (nicht die 16 Grünstufen des
// Bild-Pfads): gedämpft für Nebensächliches, hell für den Fokus.
const DIM = 2;
const BRIGHT = 4;

export const CONTAINER = { TABS: 1, BODY: 2 };

// Die Brille scrollt den Eingabe-Container SELBST — Scroll-Ereignisse kommen
// nicht als Fokuswechsel zurueck (am Geraet beobachtet: die einzeilige
// Icon-Zeile wackelte nur). Deshalb faengt der TEXT die Eingaben, und die
// Entscheidungen liegen im nativen Aktionsmenue der Brille.
export const MENU = [
  { itemID: 1, itemName: "Annehmen", wert: "annehmen" },
  { itemID: 2, itemName: "Ablehnen", wert: "ablehnen" },
  { itemID: 3, itemName: "Korrektur", wert: "korrektur" },
  { itemID: 4, itemName: "Spaeter", wert: "vertagt" },
  { itemID: 5, itemName: "Naechster Vorgang", wert: "naechster" },
];

/** Menuepunkt-ID → Entscheidungswert. */
export function menuAction(itemID) {
  return MENU.find((item) => item.itemID === itemID) || null;
}

/** Reiterzeile: aktiver Reiter in eckigen Klammern, weil der Text-Container
 *  keine Inversdarstellung kennt. */
export function tabsLine(tabs, width = 52) {
  const parts = tabs.map((tab) => (tab.active ? `[${tab.label}]` : ` ${tab.label} `));
  let line = parts.join("");
  if (line.length <= width) return line;
  // Um den aktiven Reiter herum beschneiden, damit er sichtbar bleibt.
  const activeIndex = tabs.findIndex((tab) => tab.active);
  const before = parts.slice(0, Math.max(0, activeIndex)).join("");
  const active = parts[activeIndex] || "";
  const after = parts.slice(activeIndex + 1).join("");
  const room = Math.max(0, width - active.length);
  const left = before.slice(Math.max(0, before.length - Math.floor(room / 2)));
  const right = after.slice(0, Math.max(0, room - left.length));
  line = `${left}${active}${right}`;
  return line.slice(0, width);
}

/** Sichtbares Textfenster inklusive Positionsanzeige wie in der Vorschau. */
export function bodyText(view, windowLines = BODY_LINES) {
  const scroll = clampScroll(view.scroll, view.zeilen.length, windowLines);
  return view.zeilen.slice(scroll, scroll + windowLines).join("\n");
}

/** Icon-Zeile; das fokussierte Icon wird geklammert, da invers nicht geht. */
export function iconsLine(view) {
  // ▶ existiert in der Brillenschrift, ✓/✔ nicht — das Caret markiert den Fokus.
  return view.icons
    .map((icon, i) => (i === view.focusIcon ? `▶${icon.glyph}` : ` ${icon.glyph}`))
    .join("  ");
}

/**
 * Ansichtsmodell → Container-Nutzlast für createStartUpPageContainer bzw.
 * rebuildPageContainer. Reines Objekt, damit es ohne Brille testbar bleibt.
 */
export function viewToPageContainer(view) {
  const bodyHeight = DISPLAY_H - TAB_H;
  return {
    containerTotalNum: 2,
    textObject: [
      {
        containerID: CONTAINER.TABS,
        containerName: "tabs",
        xPosition: PAD_X,
        yPosition: 0,
        width: DISPLAY_W - PAD_X * 2,
        height: TAB_H,
        content: tabsLine(view.tabs),
        textColor: BRIGHT,
        isEventCapture: 0,
        zOrderIndex: 0,
      },
      {
        // Der Eingabe-Container: die Brille scrollt genau diesen selbst.
        containerID: CONTAINER.BODY,
        containerName: "body",
        xPosition: PAD_X,
        yPosition: TAB_H,
        width: DISPLAY_W - PAD_X * 2,
        height: bodyHeight,
        content: bodyText(view),
        textColor: BRIGHT,
        isEventCapture: 1,
        zOrderIndex: 1,
      },
    ],
    menuObject: { menuItems: MENU.map(({ itemID, itemName }) => ({ itemID, itemName })) },
  };
}

/** Nur die Textinhalte — für textContainerUpgrade ohne Neuaufbau der Seite. */
export function viewToTextUpdates(view) {
  return [
    { containerID: CONTAINER.TABS, content: tabsLine(view.tabs) },
    { containerID: CONTAINER.BODY, content: bodyText(view) },
  ];
}
