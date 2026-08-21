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

| Datei | Aufgabe |
| --- | --- |
| `src/view-to-containers.mjs` | Ansichtsmodell → Container-Nutzlast (3 Text-Container: Reiter, Text, Icons) |
| `src/input.mjs` | `OsEventTypeList` → Zustandsübergänge (Scroll, Press, Doppel-Press) |
| `src/plugin.mjs` | Verdrahtung: SDK + Datenquelle, erzeugt die Seite einmal und aktualisiert danach nur Text |

## Bedienmodell (Owner-Vorgabe, unverändert)

Ein durchgehender Fluss: Reiterleiste aller offenen Items oben, darunter der
Text, unten die Icon-Zeile `✓ ✗ ✎ ◷`. Wer ans Textende scrollt, scrollt
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

## Offen (braucht Hardware bzw. Entscheidung)

1. **Transport**: Das Plugin braucht `source.load()` / `source.answer()`.
   Geplant ist eine schlanke Karten-Schnittstelle auf der Instanz über den
   Tenant-Proxy, authentifiziert mit einem **Gerätetoken** (nicht dem
   Owner-Passwort), widerrufbar. Der Proxy cached, damit das Polling die
   Instanz nicht per SSH überlastet.
2. **Zeichenbudget am Gerät prüfen**: Die Doku nennt für eine vollflächige
   Textseite ~400–500 Zeichen; das Layout nutzt 10 × 52 = 520. Möglicherweise
   müssen es 48 Zeichen je Zeile werden. Entscheidet der erste Gerätetest.
3. **Simulator/Gerätelauf**: `@evenrealities/evenhub-simulator` lokal,
   danach `evenhub pack` → `.ehpk` und Installation per QR-Code.
