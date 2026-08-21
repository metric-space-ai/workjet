# Übergabe: Brillen-Anzeige der Decision-App

**Erstellt** 2026-08-21 vom Workjet-Plan-Worker. Das Thema wurde versehentlich
hier besprochen und gehört zum Strang „CTOX Desktop an Brille anbinden“.
**Es wurde NICHTS am Code geändert** — nur analysiert. Der Arbeitsbaum ist
unangetastet.

---

## 1. Was der Nutzer will

Wörtlich, in der Reihenfolge der Nachrichten:

1. „die punkte für das scrolling fehlen und die action items ohne rahmen bitte“
2. „mach die scroll punkte für die unterseiten rein, und dann sind es action
   items kurzer name plus icon, über das man erkennen kann, aus welchem Channel
   es kommt, z.B. Mail oder Coding App etc.“
3. „inhalt box mit scroll punkte für die unter seiten.“

Daraus zusammengefasst:

- **Scroll-Punkte für die Unterseiten**, angebracht an der **Inhalts-Box**.
- **Action-Items ohne Rahmen** — die heutigen umrandeten Kästchen weg.
- Ein Action-Item ist **Kurzname + Icon**, und das Icon zeigt den **Channel**,
  aus dem der Vorgang stammt (Beispiele des Nutzers: Mail, Coding-App).

## 2. Das Referenzbild

Der Nutzer hat einen Screenshot der Even-Realities-Anzeige geschickt
(Aktien-Beispiel, grün auf schwarz). Entscheidende Merkmale:

- Ein **abgerundeter Rahmen um die gesamte Inhalts-Box**, nicht um einzelne
  Einträge.
- **Scroll-Punkte am linken Rand**, senkrecht gestapelt: eine Spalte kleiner
  Punkte, davon einige heller als Positionsanzeige. Sie liegen AUSSERHALB des
  Textes, links neben der Box.
- Zeilen im Inhalt bestehen aus **Icon (↘ ↗) + Kurzname + Wert**, wobei
  Kurzname und Wert unterschiedlich hell sind.

Das entspricht exakt dem, was `src/dots.mjs` bereits zeichnet — siehe unten.

## 3. Was im Code schon da ist (geprüft, nicht vermutet)

- **`src/dots.mjs` existiert und ist FERTIG**, wird aber von **niemandem
  importiert**. Genau deshalb „fehlen die Punkte“. `renderDots({width, height,
  count, active})` malt eine senkrechte Punktspalte; die aktive Position wird
  als länglicher Strich (3×10 px, Helligkeit 15) statt als Punkt (2×2 px,
  Helligkeit 7) gezeichnet. Wiederverwenden, nicht neu schreiben.
- **Die Rahmen sitzen in `src/view-to-containers.mjs`, Funktion `actionBoxes`.**
  Dort werden je Action gesetzt: `borderWidth` (2 fokussiert / 1 sonst),
  `borderColor` (15 / 6), `borderRadius: 6`, `paddingLength: 4`. Für „ohne
  Rahmen“ müssen diese vier weg bzw. auf 0.
- **Der Kurzname ist bereits im Modell vorhanden:** `view.icons[i]` hat
  `glyph`, `label` und `wert`. `actionBoxes` rendert heute nur `icon.glyph`;
  `icon.label` wird ausschließlich im nativen Menü benutzt
  (`menuObject.menuItems`). Für „Kurzname + Icon“ also `label` mitrendern.
- **Einen CHANNEL gibt es im Modell noch NICHT.** `view.icons` kennt keinen
  Channel, und `glasses-renderer.mjs:241` baut die Icons aus
  `decisionIcons(decision, copy, detail)`. Der Channel (Mail, Coding-App …)
  muss dort ergänzt werden — das ist eine Modelländerung, keine reine
  Darstellungsänderung.
- **Gezeichnete Icons gibt es schon** in `src/icons.mjs`: Haken, Kreuz, Stift,
  Uhr — als Bitmap, weil die Gerätefont sie nicht hat. Channel-Icons (Brief,
  Terminal …) müssten dort dazu.

## 4. Die zwei Fallen, die Zeit kosten werden

**a) Textcontainer können keine Bilder, und Bilder laufen zweistufig.**
`view-to-containers.mjs` baut ausschließlich `textObject`-Container. Das SDK
kennt `imageObject` (max. 4), aber `ImageContainerProperty` trägt NUR Position
und Größe — die Pixel kommen getrennt über `ImageRawDataUpdate.mapRawData`
(`node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts:444` und `:473`).
Wer die Punkte als Bitmap will, braucht diesen zweiten Weg. `src/layout.mjs:154`
hat bereits einen `imageObject`-Block — dort nachsehen, wie es dort gemacht
wird, statt es neu zu erfinden.

**b) Die Gerätefont ist arm, und das steht kommentiert im Code.**
`view-to-containers.mjs` vermerkt: „▶ existiert in der Brillenschrift, ✓/✔
nicht“, und `icons.mjs`: „Die Gerätefont hat weder Haken noch Kreuz, Stift oder
Uhr (am Simulator geprueft)“. Vor jedem neuen Glyphen am Simulator prüfen —
`·` und `▶` sind belegt, alles andere ist unbestätigt. Eine textbasierte
Punktspalte aus `·` wäre der billige Weg, ist aber nur zulässig, wenn sie
tatsächlich gerendert wird.

## 5. Offene Frage an den Nutzer

Der Channel muss von irgendwoher kommen. Trägt ein `vorgang` heute schon eine
Quelle (Mail / Coding-App / …), oder muss die erst im Datenmodell ergänzt
werden? Ohne diese Antwort ist das Icon geraten. `decisionIcons()` in
`../kundenpipeline-module/core/glasses-renderer.mjs:241` ist der Ort, an dem es
einzuhängen wäre.

## 6. Zustand des Arbeitsbaums

- `experiments/kundenpipeline-module/index.js` trägt **unverbuchte fremde
  Änderungen** (Versand/Delegation werden serverseitig ausgelöst, damit nicht
  Desktop UND Brille je eine Mail schicken). Die habe ich die ganze Sitzung
  bewusst nicht angefasst und auch nicht mitformatiert — nicht versehentlich
  überschreiben.
- `docs/kundenpipeline-brille-plan.md` ist unverfolgt.
- Alles unter `experiments/decision-hub-glasses/` ist unverändert gegenüber
  HEAD.
