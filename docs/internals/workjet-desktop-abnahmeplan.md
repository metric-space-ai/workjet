# Workjet Desktop – Abnahmeplan

Stand: 29. August 2026
Status: **Nicht abgenommen / nicht produktionsbereit**

## 1. Ziel und Geltungsbereich

Dieser Plan definiert die verbindliche funktionale, visuelle, responsive,
sicherheitstechnische und architektonische Abnahme der gemeinsamen Workjet-
Oberfläche. Er gilt mindestens für:

- Workjet Desktop unter Electron,
- den gemeinsamen Workjet-Web-Root,
- die darin eingebettete Business-OS-Shell,
- Code- und Business-OS-Modus,
- die aktive CTOX-Instanz und deren RxDB-/WebRTC-Datenpfad,
- den mobilen Hostmodus, soweit er dieselbe Workjet-Oberfläche responsiv hostet.

Ein Build, Typecheck, Komponenten-Test oder Screenshot allein ist keine
Abnahme. Die Anwendung gilt erst als abgenommen, wenn alle kritischen User
Stories in einer echten App-Instanz automatisiert bedient wurden und die
erwarteten Zustände nach Reload und vollständigem Neustart erhalten bleiben.

## 2. Aktuelle rote Ausgangslage

Zum Zeitpunkt dieses Dokuments sind mindestens folgende Punkte nicht
abgenommen:

- Projektanlegen besitzt inzwischen einen CTOX-Guest-Pfad, ist aber noch nicht
  gegen einen deployten revisionsgleichen Producer vollständig als
  `Create → sichtbar → Reload → Neustart` abgenommen.
- Ein bereits lokal registrierter Ordner kann als unsichtbarer Konflikt die
  Projekterstellung blockieren.
- Worker, Modelle, Harnesses, Computer und weitere Settings sind nicht überall
  nach der aktiven Business-OS-Instanz isoliert.
- Der Session-Import ist in Zuständen nicht erreichbar und kann nach dem
  Import auf eine falsche Draft-Route navigieren.
- Computer, Backend-Hosts und Business-OS-Instanzen werden in Teilen der UI
  noch vermischt.
- Der Wechsel zu einer Business-OS-Instanz kann in einem nicht behebbaren
  Verbindungszustand enden.

Solange einer dieser Punkte offen ist, lautet die Gesamteinstufung
**nicht produktionsbereit**.

## 3. Kanonisches Produkt- und Zustandsmodell

Die Abnahme prüft folgende Invarianten:

1. Eine einzige sichtbare Workjet-App vereint Code und Business OS.
2. `Code | Business OS` wechselt nur die Oberfläche, niemals die aktive
   Business-OS-/CTOX-Instanz.
3. In beiden Modi existieren genau eine Workjet-Sidebar, ein Header, ein
   Instanzselektor und ein Settings-System.
4. Die aktive CTOX-Instanz ist die einzige Source of Truth für Projekte,
   Threads, Sessions, Worker, Modelle, Harnesses, Geräte und Computerzuordnung.
5. Während Hydration, Wechsel, Fehlern oder Reconnect werden keine Daten einer
   vorherigen oder anderen Instanz angezeigt.
6. Projekte sind instanzgebundene logische Identitäten. Ein Computer besitzt
   lediglich eine Working Copy. Der Computer kann gewechselt werden, ohne eine
   zweite Projektidentität zu erzeugen.
7. Produktdaten, Commands und Geräteverwaltung verwenden ausschließlich CTOX
   RxDB/WebRTC/DataChannels. Cloudflare vermittelt nur das kurzlebige
   WSS-Signaling. Es gibt keinen HTTP-, Relay-, Primary-Environment- oder
   First-Computer-Fallback.
8. CTOX-Backend-Hosts, Code-Computer und Workjet-Geräte sind unterschiedliche
   Rollen und werden nicht als austauschbare Listenelemente dargestellt.

### 3.1 Eine Shell-Codebasis auf Desktop und Mobile

Die produktive Oberfläche besitzt genau einen Mountpfad:

`main.tsx → AppRoot → Router → AppSidebarLayout`

Dieser Pfad rendert in beiden Hosts dieselben Komponenten für Sidebar, Header,
Instanzwahl, Code, Business OS, Settings, Projekte, Threads und Composer.
Mobile darf ausschließlich responsive Layout- und Plattformadapter ergänzen.
Native Vorflächen sind nur für das erstmalige Pairing beziehungsweise
Betriebssystemfähigkeiten wie Kamera, SecureStore, Dateien, Share,
Benachrichtigungen, Insets, Tastatur und Zurück-Geste zulässig. Nach dem
Onboarding übergeben sie vollständig an den gemeinsamen Workjet-Root.

Nicht zulässig sind:

- eine native Mobile-Sidebar, ein zweites Settings-System oder ein zweiter
  Code-/Thread-/Composer-Baum,
- getrennte Desktop- und Mobile-Instanzselektoren mit eigener Produktlogik,
- ein Guest-eigener globaler Header, Modusschalter oder Instanzselektor,
- optimistische Instanzspiegel ohne bestätigte, monoton versionierte Auswahl,
- Neuaufbau von Guest, Storage-Profil, IndexedDB/RxDB oder WebRTC-Peer beim
  Wechsel zwischen Code, Business OS, Settings, Drawer oder Rotation.

Der Mobile-Host bestätigt `instance.select(requestId, presentationId)` mit
`{requestId, selectedInstanceId, revision}`. Jede Bounds-, App- und
Control-Nachricht trägt dieselbe Auswahlrevision; veraltete Revisionen werden
verworfen. Produktdaten oder Secrets dürfen den Hostport nicht passieren.

## 4. Abnahmeinfrastruktur als Pflichtvoraussetzung

Vor der eigentlichen Produktabnahme muss `workjet-ui-testing` vollständig
implementiert und selbst abgenommen sein.

### 4.1 Story-Vertrag

Jede Story enthält mindestens:

- stabile Story-ID und Version,
- Vorbedingungen und verwendetes Testprofil,
- aktive CTOX-Instanz,
- einzelne Interaktionsschritte,
- pro Schritt erwartete sichtbare Wirkung,
- erwartetes Endergebnis,
- Reload- und Neustartprüfung,
- Cleanup und erwarteten Endzustand.

Locators verwenden zuerst Rollen und zugängliche Namen, anschließend stabile
`data-workjet-action`-IDs. Koordinatenklicks sind nur für native
Betriebssystemoberflächen zulässig.

### 4.2 Watchdog

Nach jeder Aktion prüft der Runner:

- Route, Dialog, Fokus oder sichtbarer Zustand haben sich erwartungsgemäß
  verändert.
- Die Zielkontrolle ist sichtbar, enabled und nicht überlagert.
- Kein permanenter Spinner, leeres Overlay oder stiller Abbruch ist entstanden.
- Kein horizontales Seitenoverflow oder abgeschnittener notwendiger Folgeschritt
  besteht.
- Keine neue Console-, Renderer-, Main-Process- oder Guest-Exception ist
  aufgetreten.
- Die aktive CTOX-Instanz und der erlaubte Datenscope sind unverändert.
- Bei einer Mutation erscheint erst dann Erfolg, wenn die exakte CTOX-
  Projektion sichtbar ist.

Ein Klick ohne erwartete Wirkung ist eine Sackgasse und beendet die Story rot.
Der Runner darf Sackgassen nicht über interne APIs, Storage-Manipulation oder
Direktnavigation umgehen.

### 4.3 Evidenz und Review

Pro Story werden lokal gespeichert:

- versionierter Story-Vertrag,
- Schrittprotokoll mit Zeitstempeln,
- Playwright-/CDP-Trace,
- vollständiges Betriebssystemvideo,
- Renderer-, Guest- und Main-Process-Logs,
- Accessibility- und Layoutbefunde,
- Vorher-, Fehler-, Ergebnis- und Reload-Screenshots,
- strukturiertes unabhängiges Review,
- Commit, Dirty-Status, Build und verwendete Instanz.

Ein Review erhält eine Story, höchstens fünf Minuten Video und maximal vier
Screenshots. Vor externer Übergabe werden QR-Codes, Secrets, private Pfade,
Kundeninhalte und personenbezogene Daten automatisch redigiert. P0–P2-Funde
müssen in einem frischen Lauf reproduziert oder technisch widerlegt werden.

Ist der primäre Videoreviewer nicht verfügbar, bleibt der externe Reviewstatus
rot. Ein interner Reviewer darf als klar gekennzeichneter Ersatz zusätzliche
Hinweise liefern, ersetzt aber nicht still den vorgesehenen Gate.

## 5. Verbindliche kritische User Stories

### US-01 – Frischer Start und sichere Hydration

1. Electron mit einem neuen, isolierten Profil starten.
2. Verifizieren, dass keine Daten aus dem Live-Profil übernommen wurden.
3. Workjet öffnen und eine Fixture-Instanz verbinden.
4. Reload und vollständigen App-Neustart durchführen.

Erwartung:

- Keine Daten einer anderen Instanz blitzen kurz auf.
- Keine alte Relay-, Clerk-, Environment- oder HTTP-Verbindung wird aufgebaut.
- Ohne aktiven CTOX-Peer bleiben Datenansichten leer und Mutationen verständlich
  gesperrt.

### US-02 – Instanzisolation

1. Fixture-Instanz A auswählen.
2. Worker, Modelle, Harnesses, Computer, Projekte, Threads und Settings prüfen.
3. Zu Fixture-Instanz B wechseln.
4. Dieselben Bereiche öffnen.
5. Zurückwechseln, reloaden und neu starten.

Erwartung:

- Kein Datensatz aus A erscheint in B oder umgekehrt.
- Keine globale oder primäre Konfiguration überschreibt den Instanzscope.
- Direkte alte Links werden fail-closed geprüft.
- Der Moduswechsel ändert die aktive Instanz nicht.

### US-03 – Projekt anlegen und Computer wechseln

1. In Code `Projekt hinzufügen` öffnen.
2. Einen bereits vorhandenen lokalen Ordner auswählen.
3. Das logische Projekt in der aktiven CTOX-Instanz anlegen oder explizit mit
   einem vorhandenen Projekt verknüpfen.
4. Die lokale Working Copy bestätigen.
5. Sichtbaren Command- und Projektionsfortschritt beobachten.
6. Das Projekt öffnen und einen Thread erstellen.
7. Einen zweiten zugewiesenen Computer auswählen.
8. Dort eine Working Copy materialisieren oder verknüpfen.
9. Reload und vollständigen Neustart durchführen.

Erwartung:

- Der Dialog schließt erst nach terminalem Command-Erfolg und sichtbarer exakter
  CTOX-Projektion.
- Ein vorhandener Ordner führt weder zu einer technischen Invariant-Meldung
  noch zu einem unsichtbaren Erfolg.
- Projektidentität und Thread bleiben beim Computerwechsel gleich.
- Fortschritt unterscheidet Projektanlage, Working-Copy-Verifikation,
  Materialisierung/Clone, Indexierung und echten Dateitransfer.
- Ein abgebrochener Vorgang ist wiederholbar und erzeugt kein Duplikat.

### US-04 – Session statisch importieren

1. Harness-Settings öffnen.
2. Codex- und Claude-Sitzungen inventarisieren.
3. Eine oder mehrere Sitzungen auswählen.
4. Import ausführen und importierten Thread öffnen.
5. Import erneut ausführen.
6. Quelldateien und Quellanwendungen prüfen.

Erwartung:

- Auswahlkontrollen sind sichtbar und bedienbar.
- Importiert wird in die aktive CTOX-Instanz.
- Navigation verwendet die kanonische Thread-Route, keine Draft-Route.
- Wiederholung ergänzt nur neue Inhalte und dupliziert nichts.
- Die Quellanwendungen und deren Dateien bleiben unverändert.

### US-05 – Vollständiger Composer

1. Neues Projekt beziehungsweise vorhandenes Projekt öffnen.
2. Worker/Manual, Computer, Harness, Modell, Effort/Kontext, Systemprompt,
   Tools und Upload bedienen.
3. Bild und Datei anhängen.
4. Nachricht senden und Ergebnis abwarten.
5. Schmale und kompakte Fensterbreiten wiederholen.

Erwartung:

- Verbindliche Reihenfolge und vollständige Aktionen sind vorhanden.
- Breite Ansichten nutzen eine Zeile; kleinere Ansichten wechseln kontrolliert
  auf zwei oder drei Zeilen.
- Kein Element wird abgeschnitten oder überlagert.
- Auswahl und Draft bleiben nach Reload erhalten, aber nur in ihrer Instanz.

### US-06 – Code und Business OS

1. In Code eine Instanz und ein Projekt auswählen.
2. Sidebar ein- und ausblenden.
3. Zu Business OS wechseln.
4. Apps, Menüs, Settings und Chat-Dock bedienen.
5. Zurück zu Code wechseln.

Erwartung:

- Genau eine Workjet-Chrome bleibt sichtbar.
- Instanz, Sidebarzustand und CTOX-Peer bleiben stabil.
- Kein zweiter Header, kein zweites Zahnrad und keine zweite globale
  Navigation erscheinen.
- Header, Icons, Fensteraktionen und App-Raster bleiben vollständig.

### US-07 – Workjet-Gerät verbinden und widerrufen

1. Settings → Business OS → aktive Instanz → Workjet-Geräte öffnen.
2. `Gerät hinzufügen` ausführen.
3. QR sowie Ablauf und Instanzname prüfen.
4. Manuelle Verbindungsdaten öffnen; Passwort bleibt zunächst maskiert.
5. QR physisch oder über Fixture scannen.
6. Binding-Liste aktualisieren.
7. Binding widerrufen und Reconnect prüfen.

Erwartung:

- Invite/Create/List/Revoke laufen ausschließlich über
  `ctox.workjet.device.v1` auf dem aktiven WebRTC-DataChannel.
- Kein Secret erscheint in Logs, Accessibility-Texten oder Persistenz.
- Schließen, Hintergrundwechsel, Erneuern, Instanzwechsel und Widerruf löschen
  die Invite-Daten aus dem UI-Speicher.
- Der QR besteht einen Render→Decode-Test auf einem Galaxy-Fold-Viewport.

### US-08 – Computerrollen und Hostschutz

1. Globales Computerinventar öffnen.
2. Computer einer Business-OS-Instanz eindeutig zuweisen.
3. Umhängen auf eine andere Instanz prüfen.
4. Managed Backend Host als Worker zuweisen wollen.
5. Self-hosted Co-Location aktivieren wollen.

Erwartung:

- Jeder Computer gehört höchstens einer Business-OS-Instanz.
- Managed Backend Hosts werden serverautoritativ abgelehnt.
- Self-hosted Co-Location ist standardmäßig aus und erfordert die vollständige
  Hochrisikowarnung plus explizite Bestätigung.
- Hostnamen und Presentation-IDs dienen nie als Autorität.

### US-09 – Alle Settings, Menüs und Dialoge

Jeden sichtbaren Menüpunkt, Tab, Button, Popover, Tooltip, Dialog, Empty State,
Fehlerzustand und Rückweg in Code und Business OS mindestens einmal bedienen.

Erwartung:

- Jede Aktion hat einen sichtbaren Effekt und einen klaren Rückweg.
- Fokus wird beim Öffnen korrekt gesetzt, bleibt modal gefangen und kehrt beim
  Schließen zurück.
- Texte sind pro Ansicht vollständig Deutsch oder Englisch.
- Interne Begriffe erscheinen nur in eingeklappten Diagnosedetails.

### US-10 – Freigegebene Business-OS-Apps

Jede freigegebene App öffnen, verschieben, minimieren, maximieren,
wiederherstellen und schließen. Hauptaktionen und Scrollzustände prüfen.

Erwartung:

- Gemeinsame Fenster-Chrome und vollständige Aktionen sind vorhanden.
- Theme, Kategorieakzent und Icon-Fallback stimmen überein.
- Keine private Kunden-App erscheint außerhalb ihrer signiert gebundenen
  Instanz.

### US-11 – Responsive und mobile Hostoberfläche

Die gemeinsamen Stories in Desktop breit, mittel, schmal und kompakt sowie im
mobilen Hostmodus wiederholen.

Erwartung:

- Mobile verwendet dieselbe Workjet-IA und dieselben Funktionen, nur mit
  responsiven Interaktionsadaptern.
- Keine zweite Mobile-Navigation oder funktional reduzierte Parallel-App.
- Header, Sidebar, Settings, Projekt-/Threadansichten und Composer bleiben
  vollständig erreichbar.

## 6. Abnahmematrix

Jede kritische Story wird mindestens in folgender Matrix bewertet:

| Dimension        | Werte                                                     |
| ---------------- | --------------------------------------------------------- |
| Modus            | Code, Business OS                                         |
| Theme            | Dark, Light                                               |
| Sprache          | Deutsch, Englisch                                         |
| Desktop-Viewport | Wide, Medium, Narrow, Small                               |
| Host             | Electron, Web, mobiler gemeinsamer Host                   |
| Zustand          | frisches Profil, bestehendes Profil, Reload, App-Neustart |
| Instanz          | Fixture A, Fixture B, getrennte/offline Instanz           |

Nicht jede Kombination muss jede lange Story vollständig wiederholen. Für jede
ausgelassene Kombination ist aber im Abnahmebericht eine begründete
Äquivalenzentscheidung erforderlich. Instanzisolation, Projektanlage,
Navigation und Responsive-Chrome dürfen nicht über Äquivalenz übersprungen
werden.

## 7. Sicherheits- und Architektur-Gates

Der Release-Build wird statisch und zur Laufzeit geprüft auf:

- keine produktiv erreichbaren ManagedRelay-/EnvironmentHttp-Imports,
- keine Clerk-/DPoP-Websession als Produktdatenautorität,
- keine `relay.t3.codes`-, PlanetScale-, Axiom- oder ctox.dev-Control-
  Abhängigkeit,
- keine HTTP-/REST-/WebSocket-RPC-Produktdatenroute,
- keine HTTP-Fallback-Anfrage nach WebRTC-Fehler,
- nur Cloudflare-WSS-Signaling und danach WebRTC-DataChannels,
- keine instanzfremden Daten während Hydration, Wechsel oder Fehler,
- keine Secrets oder Kundeninhalte in Logs und Evidenz,
- keine ungebundenen Kunden-Apps in globalen Bundles oder Instanzen.

Ein einzelner Verstoß blockiert die Freigabe.

## 8. Visuelle und Accessibility-Abnahme

Für jede Matrixklasse werden automatisiert geprüft:

- horizontales und vertikales Overflow,
- abgeschnittene oder überlagerte Controls,
- doppelte Aktionen, Header, Footer und Settings-Einstiege,
- Mindestgröße interaktiver Ziele,
- sichtbarer Tastaturfokus und logische Tab-Reihenfolge,
- zugängliche Namen und Rollen,
- WCAG-AA-Kontrast,
- konsistente Surface-, Radius-, Spacing- und Typografietokens,
- vollständige Icons und deterministische Fallbacks,
- gemeinsame App-Kacheln, Fensteraktionen und Kategorieakzente,
- nutzerverständliche Lade-, Leer-, Fehler- und Erfolgszustände.

Baseline-Änderungen benötigen eine schriftliche Begründung und dürfen einen
Fehler nicht lediglich als neuen Sollzustand akzeptieren.

## 9. Fehlerklassifikation und Fixprozess

| Schweregrad | Bedeutung                                                         | Konsequenz                                 |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------ |
| P0          | Daten-/Mandantenleck, Secret-Leak, Crash, irreversible Mutation   | Sofortiger Release-Stopp                   |
| P1          | Kritische Story blockiert oder falscher Instanzscope              | Release-Stopp                              |
| P2          | Wesentliche Fehlfunktion, Sackgasse oder schwerer UX-/A11y-Defekt | Release-Stopp bis reproduziert und behoben |
| P3          | begrenzter visueller oder textlicher Defekt ohne Workflowblockade | vor Release triagieren                     |

Fixablauf:

1. Fund in einem frischen Lauf reproduzieren.
2. Ursache anhand technischer Evidenz bestimmen.
3. Kleinsten fachlich vollständigen Fix implementieren.
4. Fokussierten Verhaltenstest ergänzen.
5. Betroffene Story vollständig wiederholen.
6. Unabhängigen Review des Fix-Batches durchführen.
7. Erst danach den Fund schließen.

## 10. Abnahmebericht

Der Abschlussbericht enthält:

- exakten Commit und Dirty-Status,
- verwendete Electron-, Web- und Mobile-Builds,
- verwendete Fixture-Instanzen und Profile,
- jede Story mit `PASS`, `FAIL`, `BLOCKED` oder `NOT RUN`,
- getestete Matrixkombinationen,
- Links auf Video, Trace, Screenshots und Logs,
- Console-, Main-Process-, Guest- und Netzwerkbefunde,
- Cleanupstatus,
- offene P0–P3-Funde,
- explizite Gesamteinstufung.

Zulässige Gesamteinstufungen:

- **Produktionsbereit:** alle kritischen Storys bestanden, keine offenen
  P0–P2-Funde und alle Architektur-Gates grün.
- **Funktioniert lokal:** lokale Storys bestanden, Release-/Produktionsbeweis
  fehlt.
- **Backend bereit:** technische Datenpfade bestanden, UI-Storys fehlen.
- **Nicht produktionsbereit:** mindestens eine kritische Story fehlgeschlagen,
  blockiert oder nicht ausgeführt.

## 11. Harte Freigabekriterien

Workjet Desktop/Web darf erst freigegeben werden, wenn:

- der UI-Testing-Skill und sein Runner vollständig implementiert und per
  absichtlich defekter Fixture selbst getestet sind,
- alle User Stories US-01 bis US-11 automatisiert ausgeführt wurden,
- Projektanlage und Session-Import real funktionieren,
- Instanzisolation nach Wechsel, Reload und Neustart bewiesen ist,
- Code und Business OS dieselbe Instanz, Chrome und Settings verwenden,
- Pairing, Projekt-/Threaddaten und Commands ausschließlich CTOX
  RxDB/WebRTC/DataChannels verwenden,
- keine P0–P2-Funde offen sind,
- keine unerwarteten Console-, Main-, Guest- oder Netzwerkfehler auftreten,
- die Evidenz revisionsgebunden, vollständig und redigiert vorliegt.

Bis dahin ist jede andere Aussage als **nicht produktionsbereit** unzulässig.

## 12. Revisionsgebundener Arbeitsstand

Diese Liste dokumentiert nur nachgewiesene Zwischenstände. Ein abgehakter
Baustein ersetzt keine vollständige User-Story-Abnahme.

### 12.1 Abgeschlossen und nachgewiesen

- [x] Shell 0.1.11 ist mit Manifest-/Archivhashes gepinnt
      (`39b02fd3`).
- [x] Ein zentraler `ActiveWorkjetScope` hält Modus, aktive Instanz und eine
      monotone Auswahlrevision (`aa6ca230`).
- [x] Desktop-Auswahl committet synchron; ein installierter Mobile-Host-Port
      darf die Auswahl erst nach korreliertem persistiertem Ack übernehmen.
- [x] Stale und gleich-revisionierte widersprüchliche Mobile-Acks werden
      verworfen; eine DOM-Diagnose weist aktive Instanz und Revision aus.
- [x] Projekt-List/Create erreicht ausschließlich den bereits existierenden
      warmen Guest der explizit ausgewählten Instanz. Eine beliebige Instanz-ID
      erzeugt keinen Guest und fällt mit `not_active` geschlossen aus.
- [x] Contracts-, Web- und Desktop-Typechecks sind auf `aa6ca230` grün.
- [x] 154 fokussierte Contract-/Scope-/Projekt-/Shell-/Desktop-IPC-Tests sind
      auf `aa6ca230` grün.
- [x] Web-Produktionsbuild auf `aa6ca230`: 4.764 Module erfolgreich gebaut.
- [x] Sichtbare Debug-Story `Business OS → Code → Business OS → Code` auf
      Welsch bestand 4/4 Schritte ohne Runner-Fund. Evidenz:
      `runtime/workjet-ui-testing/e4312d899983862b3cad4aea45b9d19d27dedc8f/2026-08-29T08-02-34-037Z-e0f166`.
- [x] CTOX-native Computerzuordnung ist isoliert implementiert und getestet:
      `62df22c4b1c0c6515a6eda55510faecc1cf365d1` (RxDB-JS 109/109,
      Computer 5/5, Projekt 7/7, Schema-/Command-Gates grün).
- [x] CTOX Business-OS-Shell-Layout/Fensterverhalten ist isoliert korrigiert:
      `169c69e9029c992602e72eb9033bf7251aed166c` (Shared JS 263/263,
      Coding Agents 19/19, reale 860×720-/640×720-Geometrie grün).

### 12.2 Noch offen – blockiert weiterhin den Release

- [ ] Die beiden isolierten CTOX-Commits sind konfliktgeprüft in einen
      revisionsgebundenen CTOX-Head integriert, gepusht und auf Welsch deployt.
- [ ] US-03 `Projekt anlegen → sichtbar → Reload → App-Neustart` ist gegen
      genau diesen CTOX-Head vollständig grün.
- [ ] Ein Computer lässt sich in der gemeinsamen Settings-IA sichtbar einer
      Instanz zuweisen, wechseln und wieder lösen.
- [ ] US-02 beweist die Isolation von Projekten, Computern, Workern, Modellen,
      Harnesses, Threads, Sessions und Settings mit zwei Fixture-Instanzen.
- [ ] US-04 Session-Import ist sichtbar bedienbar, idempotent und nach Reload
      in der aktiven CTOX-Instanz vorhanden.
- [ ] US-05 vollständiger Composer ist interaktiv in Wide/Narrow/Mobile
      abgenommen.
- [ ] US-07 Pairing/Create/List/Revoke ist einschließlich physischem Fold-Scan
      und serverautoritativ bestätigtem Binding grün.
- [ ] Der Mobile-Host installiert den `ActiveWorkjetScope`-Selection-Adapter,
      löst ihn erst aus `host.context.sync` auf und beweist
      `RN persisted ID = Ack ID/Revision = Web DOM ID/Revision`.
- [ ] Alle sichtbaren Settings-/Menü-/Dialog-/App-Aktionen besitzen positive,
      Fehler-, Abbruch- und Rückweg-Stories.
- [ ] GLM-5.3-Flash-Review beziehungsweise der ausdrücklich benannte
      Ersatzreview ist für alle kritischen Stories vorhanden.
- [ ] US-01 bis US-11 und die Matrix aus Abschnitt 6 sind vollständig
      revisionsgebunden ausgeführt.
