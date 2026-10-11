# Workjet UI-Vertrag v1 (verbindlich, 11.10.2026)

Grundlage:
- Die Owner-Vorgaben von Michael.
- Das Audit vom 11.10.2026: Kimi ×3 und Grok ×3, alle 356 UI-Dateien, 225 deduplizierte Befunde (findings-all.json).
- Beide Modelle haben unabhängig voneinander dieselben Bausteine vorgeschlagen.

Wer UI baut:
- UI entwerfen und bauen NUR Kimi oder Grok.
- Codex/GPT liefert nur Backend und Schnittstellen.

Ziel: Die Oberfläche ist aus einem Guss, einfach und verständlich. Sie zeigt Inhalt statt Erklärungen.

## 1. Vier Bausteine, keine Sonderlösungen

1. **Dialog** (`ui/dialog`)
   - Aufbau: Titel, Schließen-X oben rechts, optional EIN Segment direkt unter dem Titel (z. B. Local | SSH | Tailscale), darunter nur die Felder der gewählten Option.
   - Fuß: „Abbrechen“ und eine Primäraktion.
   - Eine Breite (Standard), Ausnahmen nur über eine benannte Variante.
   - Verboten:
     - `DialogDescription` als Erklärsatz; erlaubt ist nur eine Fehler- oder Statuszeile;
     - Karten im Dialog;
     - Wizard-Schritte, ein Dialog über einem Dialog, Vorauswahl-Popups;
     - „Zurück“ oder „Abbrechen“ im Inhalt;
     - Advanced-Aufklapper.
2. **Zeile** (`ui/row`, neu)
   - Aufbau: Statuspunkt, Name (darunter höchstens eine kurze Meta-Zeile wie Adresse), Chips, Aktiv-Schalter, Papierkorb mit Bestätigung, ⋯-Menü für Seltenes (Bearbeiten, Reparieren, Neu prüfen).
   - Ein Objekt hat genau eine Zeile. Listen aller Art nutzen diese Zeile: Instanzen, Rechner, Lumas, Projekte, PRs, Konten, Modelle.
3. **Leerzustand** (`ui/empty`)
   - Titel (höchstens 4 Wörter) und ein Primär-Button.
   - Kein Absatz, keine Illustration.
   - Ein Laden endet immer: nach 10 s Statuszeile mit „Erneut versuchen“, nie ein endloses Skeleton, nie `return null`.
4. **Einstellungszeile** (`SettingsRow`)
   - Aufbau: Bezeichnung (höchstens 3 Wörter) und Steuerelement, optional eine Statuszeile.
   - Die Prop `description` entfällt. Ihre Erklärsätze werden gelöscht, nicht verschoben.

Dazu gehören zwei kleine Elemente:
- **Banner**: Icon, eine Zeile, ein bis zwei Buttons.
- **Toast**: eine Zeile, höchstens eine Aktion als Button.

## 2. Textregeln

- Keine Erklärsätze in Dialogen, Popovers, Menüs, Einstellungen oder Leerzuständen.
- Erlaubt sind nur:
  - Titel;
  - Bezeichnungen mit höchstens 3 Wörtern;
  - Platzhalter;
  - eine Fehler- oder Statuszeile mit höchstens 12 Wörtern.
- Fehlende Werte zeigen „—“, nie einen Satz.
- Jede Aktion ist ein Button aus `ui/button` mit genau diesen Varianten:
  - primär (`default`),
  - sekundär (`outline`),
  - `ghost` nur für Icon-Buttons mit Tooltip,
  - `destructive` nur in Bestätigungen.
- Verboten sind unterstrichene oder gepunktete Textaktionen und Aktionen in `text-xs`-Optik.
- Keine Rohdaten (IDs, Hashes, Pfade, JSON, Revisionen) außerhalb von „Diagnose“.

## 3. Erkennen statt fragen

Michael: „wenn eine GPU da ist, kann sie benutzt werden, wenn Build, dann halt alle CPUs“.

- Kein Formular für Werte, die die App erkennen oder ableiten kann:
  - Verbindung, Host-Key, Schlüssel;
  - CPU, RAM, GPU, VRAM, Platz, Toolchains;
  - environment id, thread id.
- Übrig bleiben nur echte Entscheidungen, als Haken oder Schalter.
- Vorhandenes (SSH-Aliasse, Schlüssel, tailnet-Geräte, bekannte Rechner und Threads) wird als Auswahl angeboten, nie getippt.

## 4. Sprache und Begriffe

- Sichtbare UI-Sprache ist Deutsch, durchgehend, aus dem Sprachkatalog. Keine harten englischen Strings in Ansichten.
- Englisch bleibt nur bei Eigennamen und Modellnamen.
- Feste Begriffe:

  | Begriff | Bedeutung | Statt |
  |---|---|---|
  | Instanz | CTOX-Instanz | Instance, Business OS (als Ortsname), CTOX-Master |
  | Rechner | Computer, Maschine | Computer, Machine |
  | Luma, Plural Lumas | KI-Worker | Agent, Worker (sichtbar) |
  | Projekt | – | Project |
  | Regeltermin | – | Jour fixe (sichtbar) |
  | Einstellungen | – | Settings |
  | Modell, Harness | – | – |

## 5. Icons (lucide, eine Strichstärke, `size-4` in Zeilen, `size-3.5` in Leisten)

| Begriff | Icon | Verboten |
|---|---|---|
| Instanz | Server bzw. Knoten (`server`) | – |
| Rechner | Monitor (`monitor`) | – |
| Luma | Person (`user-round` bzw. `bot` nur für Systemakteure) | Schraubenschlüssel |
| Modell | Anbieterzeichen bzw. `cpu` | Glitzerstern, ✨ |
| Harness | Terminal (`terminal`) | – |
| Werkzeug | Schraubenschlüssel (`wrench`), NUR echte Werkzeuge | – |
| Neu | Text-Chip „Neu“ | Glitzerstern |

## 6. Version auf einen Blick

- Fest sichtbar im Fuß der Seitenleiste bzw. im Kopf neben dem Zahnrad: `Workjet 0.0.85 · Host 0.1.3 · <Instanz> <Build-Kurz-SHA>`.
- Klick öffnet Details: Versionen, Update-Status, Diagnose.
- Ein Update-Hinweis ist ein Chip daneben, kein Toast mit Absatz.

## 7. Layout

- Dicht statt luftig: Tabellenzeilen, Chips, volle Breite, Abschnittsabstand 16–20 px.
- Schriftstufen: 22 (Seitentitel), 13.5 (Inhalt), 12 (Meta, Spaltenkopf), 11 (Chip). Keine weiteren `text-[Npx]`.
- Stabil beim Laden: Zeilen springen nicht, ein Chip „prüft…“ statt Ein- und Ausblenden.
- 420 px: einspaltig, kein horizontales Scrollen, Tabellen werden Zeilen-Blöcke.

## 8. Wächter (Pflicht, im Repo)

Ein Test in apps/web schlägt fehl bei:
- (a) `DialogDescription`, `EmptyDescription` oder `SettingsRow description` mit einem Satz über 12 Wörter;
- (b) `hover:underline` bzw. `underline` auf `button` oder `a` mit onClick;
- (c) den verbotenen Icon-Zuordnungen aus §5;
- (d) englischen Literal-Strings in JSX der Einstellungen, Dialoge und Leerzustände, nach einer Allowlist für Eigennamen.

Bestehende Verstöße werden in der jeweiligen Welle abgebaut. Eine Baseline-Datei darf nur schrumpfen.

## 9. Abnahme je PR

- Screenshots vorher und nachher je betroffener Ansicht, 1440×900 dark und 420 px, aus dem headless Prüfweg (`workjet serve --mode web` mit eigenem `--base-dir` und `--dev-url` auf den eigenen Vite-Server). Nie Workjet.app oder Electron starten.
- Je Befund-ID aus findings-all.json im eigenen Bereich: behoben oder begründet offen.
- Wächter grün, betroffene Tests grün, Lane grün.
- Merge erst nach meiner Sichtprüfung der Screenshots.
