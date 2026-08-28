# Decision Hub auf der Even Realities G2

Even-Hub-Plugin: Der Besitzer entscheidet Kundenvorgänge auf der Brille.
Das Plugin ist eine Web-App auf dem Handy; die Brille ist Anzeige und
Eingabe (`@evenrealities/even_hub_sdk`).

## Warum das hier so geschnitten ist

Die Brille rendert **kein HTML**. Sie setzt die Seite aus SDK-Containern
zusammen, die per absoluter Pixelposition liegen: max. 8 Text- und 4
Bild-Container (zusammen 1..12), und **genau einer** trägt
`isEventCapture: 1`. Bild-Container sind auf 288×144 px begrenzt, also ein
Viertel der Fläche — ein vollflächiges Bitmap ist nicht möglich.

Deshalb ist nur der Malschritt neu. Die Ansicht selbst kommt unverändert aus
`../kundenpipeline-module/core/glasses-renderer.mjs` (`buildView()` ist rein);
dieselbe Logik treibt die Desktop-Vorschau in der Business-OS-App. Es gibt
keine zweite Wahrheit über das Layout.

| Datei                        | Aufgabe                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `src/view-to-containers.mjs` | Ansichtsmodell → Container-Nutzlast (3 Text-Container: Reiter, Text, Icons)               |
| `src/input.mjs`              | `OsEventTypeList` → Zustandsübergänge (Scroll, Press, Doppel-Press)                       |
| `src/plugin.mjs`             | Verdrahtung: SDK + Datenquelle, erzeugt die Seite einmal und aktualisiert danach nur Text |

## Bedienmodell (Owner-Vorgabe, unverändert)

Ein durchgehender Fluss: Reiterleiste aller offenen Items oben, darunter der
Text, unten die Entscheidungszeile `OK NEIN KORREKTUR SPÄTER` (die Gerätefont
kennt keine Häkchen-Glyphen). Wer ans Textende scrollt, scrollt
weiter auf die Icons; über das letzte Icon hinaus beginnt das nächste Item.
Press aktiviert das fokussierte Icon, Doppel-Press führt in den Text zurück.
Swipe bewegt zwei Zeilen — bewusst grob gegen Übersensibilität.

Die SDK-Ereignisse decken das exakt ab: `CLICK_EVENT(0)`,
`SCROLL_TOP_EVENT(1)`, `SCROLL_BOTTOM_EVENT(2)`, `DOUBLE_CLICK_EVENT(3)`.

## Grenzen, die im Test festgenagelt sind

- höchstens 8 Text-Container, `containerTotalNum` 1..12
- genau ein Container mit `isEventCapture: 1`
- kein Container ragt über 576×288 hinaus
- Textbudget beim Seitenaufbau ≤ 1000 Zeichen
- jedes Entscheidungs-Icon ist per Scroll erreichbar
- Press im Text beantwortet **nichts** (nur auf einem Icon wird geantwortet)

## Test

```bash
npm test
```

Läuft ohne Brille und ohne Handy: SDK und Datenquelle sind in den Tests
ersetzt. `node --test tests/` (Verzeichnisform) funktioniert auf dieser
Node-Version nicht — die Dateien müssen einzeln genannt werden, wie im
`test`-Skript.

## Am Simulator gemessen (nicht geraten)

Diese Werte stammen aus echten Läufen mit `evenhub-simulator` 0.9.1 und
Screenshots des Framebuffers. Sie haben das Layout mehrfach korrigiert:

| Befund                                                                              | Konsequenz                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `zOrderIndex` muss je Container **eindeutig** sein                                  | Doppelte 0 → `CreateStartUpPageContainer validation failed`, Seite entsteht gar nicht |
| Die Gerätefont hat **kein** ✓ ✔ ✗ ✘ ✎ ◷ ▸ ⌛ ⏱ ➤ ▪                                  | Entscheidungszeile blieb komplett leer; jetzt Wörter + Caret `▶`                      |
| Verfügbar sind u. a. `… ◑ ▶ ▷ ● ○ » « • → ↓ ↑ ■ □ ◆`                                | Abschnittsmarker `▸` → `»`                                                            |
| Deutsche Umlaute, Akzente, Ziffern, Satzzeichen: **alle vorhanden**                 | Deutsche Oberfläche ist unkritisch                                                    |
| Zeilenschrittweite **26 px**, Textgröße nicht einstellbar                           | Geometrie ist Messwert, keine Designentscheidung                                      |
| Reiterzeile + Entscheidungszeile kosten zwei Zeilen                                 | **8 Textzeilen** passen, nicht die erhofften 10                                       |
| Zu knappe Icon-Zeile schneidet Umlautpunkte ab                                      | „SPÄTER" wurde zu „SPATER"; Zeile bekommt den Restplatz                               |
| Host liefert Ereignisse **bereits geparst** als `{jsonData, textEvent:{eventType}}` | `evenHubEventFromJson()` greift hier nicht — direkt lesen                             |
| `sysEvent` 4/5 sind Vorder-/Hintergrund                                             | Dürfen nie als Geste durchgehen (Test hält das fest)                                  |

## Selbst verifizieren

```bash
npm run dev      # Vite auf 5173
npm run sim      # Simulator + Automations-API auf 9898
curl -X POST -H 'content-type: application/json' -d '{"action":"down"}' http://127.0.0.1:9898/api/input
curl -o glasses.png http://127.0.0.1:9898/api/screenshot/glasses
```

Der Simulator braucht **kein Konto** und läuft offline. Fehlende Zeichen
stehen als `glyph dsc. not found for U+XXXX` im Simulator-Log (stderr),
nicht in `/api/console` — dort landet nur die JS-Konsole.

## Offen (braucht Hardware bzw. Entscheidung)

1. **Transport**: Das Plugin braucht `source.load()` / `source.answer()`.
   Geplant ist eine schlanke Karten-Schnittstelle auf der Instanz über den
   Tenant-Proxy, authentifiziert mit einem **Gerätetoken** (nicht dem
   Owner-Passwort), widerrufbar. Der Proxy cached, damit das Polling die
   Instanz nicht per SSH überlastet.
2. ~~Zeichenbudget prüfen~~ — erledigt: 8 × 52 = 416 Zeichen, klar innerhalb
   des Budgets. Die Zeilenzahl entschied ohnehin die Pixelhöhe, nicht das
   Zeichenbudget.
3. **Simulator/Gerätelauf**: `@evenrealities/evenhub-simulator` lokal,
   danach `evenhub pack` → `.ehpk` und Installation per QR-Code.
