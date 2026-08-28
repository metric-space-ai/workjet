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
const ICON_H = 30;
const LINE_H = 26;

// 0..4 Helligkeitsstufen des Text-Containers (nicht die 16 Grünstufen des
// Bild-Pfads): gedämpft für Nebensächliches, hell für den Fokus.
const DIM = 2;
const BRIGHT = 4;

export const CONTAINER = { TABS: 1, BODY: 2, ACTION_BASE: 10 };

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
  // Echte Reiterleiste: aktiver Reiter in Klammern, die uebrigen durch einen
  // Trenner abgesetzt — sonst verschwimmt sie zu einem Wortsalat.
  const parts = tabs.map((tab, i) => {
    const text = tab.active ? `[${tab.label}]` : ` ${tab.label} `;
    return i === 0 ? text : `·${text}`;
  });
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
// Gestaltung: die Brille kann mehr als Fliesstext. TextContainerProperty hat
// borderWidth/borderRadius/paddingLength und je Container eine eigene
// Helligkeit (0..4). Jede Aktion bekommt deshalb ein eigenes Kaestchen; die
// fokussierte wird umrandet und hell, der Rest bleibt gedaempft.
const ACTION_GAP = 6;
const CHAR_W = 9.2; // am Simulator gemessen

export function actionBoxes(view, y, height) {
  const count = view.icons.length || 1;
  const usable = DISPLAY_W - PAD_X * 2;
  const width = Math.floor((usable - ACTION_GAP * (count - 1)) / count);
  return view.icons.map((icon, i) => {
    const focused = i === view.focusIcon;
    const label = icon.glyph;
    // Text im Kaestchen zentrieren: der Container kennt keine Ausrichtung,
    // also mit Leerzeichen ausgleichen.
    const inner = Math.max(1, Math.floor((width - 8) / CHAR_W));
    const pad = Math.max(0, Math.floor((inner - label.length) / 2));
    return {
      containerID: CONTAINER.ACTION_BASE + i,
      containerName: `action-${icon.wert}`,
      xPosition: PAD_X + i * (width + ACTION_GAP),
      yPosition: y,
      width,
      height,
      content: `${" ".repeat(pad)}${label}`,
      textColor: focused ? BRIGHT : DIM,
      borderWidth: focused ? 2 : 1,
      // Ohne borderColor zeichnet die Brille nur eine Kante — am Simulator
      // gesehen. 0..15 sind die Gruenstufen des Rahmens.
      borderColor: focused ? 15 : 6,
      borderRadius: 6,
      paddingLength: 4,
      isEventCapture: 0,
      zOrderIndex: 3 + i,
    };
  });
}

export function viewToPageContainer(view) {
  const actionH = 30;
  const bodyHeight = BODY_LINES * LINE_H + 10;
  const actionY = DISPLAY_H - actionH;
  const actions = actionBoxes(view, actionY, actionH);
  return {
    containerTotalNum: 2 + actions.length,
    textObject: [
      {
        containerID: CONTAINER.TABS,
        containerName: "tabs",
        xPosition: PAD_X,
        yPosition: 0,
        width: DISPLAY_W - PAD_X * 2,
        height: TAB_H,
        content: headerLine(view),
        textColor: view.focusIcon >= 0 ? DIM : BRIGHT,
        borderWidth: 0,
        isEventCapture: 0,
        zOrderIndex: 0,
      },
      {
        // Eingabe-Container. Sein Inhalt ist IMMER genau ein Fenster gross —
        // laeuft er ueber, scrollt die Brille ihn selbst und die Ereignisse
        // erreichen die App nicht mehr (am Geraet beobachtet).
        containerID: CONTAINER.BODY,
        containerName: "body",
        xPosition: PAD_X,
        yPosition: TAB_H,
        width: DISPLAY_W - PAD_X * 2,
        height: bodyHeight,
        content: bodyText(view),
        textColor: view.focusIcon >= 0 ? DIM : BRIGHT,
        isEventCapture: 1,
        zOrderIndex: 1,
      },
      ...actions,
    ],
    // Zusaetzlich das native Aktionsmenue: solange der Druck aufs Kaestchen am
    // Geraet nicht bestaetigt ist, gibt es so IMMER einen Weg zur Entscheidung.
    menuObject: {
      menuItems: view.icons.map((icon, i) => ({
        itemID: i + 1,
        itemName: icon.label || icon.glyph,
      })),
    },
  };
}

/** Kopfzeile: Reiter plus Leseposition — sonst weiss niemand, wie viel folgt. */
export function headerLine(view) {
  const pos = view.position;
  const marker = pos && pos.total > 0 ? ` ${pos.line}/${pos.total}` : "";
  const room = Math.max(10, 52 - marker.length);
  return `${tabsLine(view.tabs, room)}${marker}`;
}

/** Nur die Textinhalte — für textContainerUpgrade ohne Neuaufbau der Seite. */
export function viewToTextUpdates(view) {
  return [
    { containerID: CONTAINER.TABS, content: headerLine(view) },
    { containerID: CONTAINER.BODY, content: bodyText(view) },
  ];
}
