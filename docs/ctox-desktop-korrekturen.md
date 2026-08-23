# CTOX Desktop — offene Korrekturen

Stand 2026-08-24, aus dem Chat-Abgleich mit dem Betreiber. Jede Position
nennt: was fehlt, warum es bisher fehlt, was FERTIG konkret bedeutet.
Reihenfolge = Abarbeitungsreihenfolge. Erledigtes wird hier gestrichen,
nicht gelöscht.

Verwandt: [ctox-desktop-board.md](ctox-desktop-board.md) trägt die
erledigten Arbeiten dieser Sitzung, die Environment-Fallen und die
Fehlermuster. Dieses Dokument trägt NUR das Offene.

---

## 0 · Sofort prüfen: bringt Gateway-Routing Claude zurück?

`providerInstances.claudeAgent.routeViaGateway = true` ist seit 2026-08-24
gesetzt (war überall aus — DER Grund, warum jeder Harness native
Zugangsdaten benutzte und Claude an einem toten Token scheiterte, obwohl
der Gateway-Account gesund ist).

FERTIG heißt: Neuer Thread → Claude-Modell → Nachricht → echte Antwort,
belegt per DB (`state=completed`, Dauer > 2 s). Scheitert es, steht die
echte Fehlerkette in `~/.t3/userdata/logs/provider/events.<threadId>.log`.

## 1 · Menüs (A1–A3): Worker · Rechner · fünf Reiter

**A1 — „Workjet" → „Worker".** Zweimal angewiesen, nie umgesetzt.
`SETTINGS_SECTION_LABELS` in `settingsSearch.ts:30`. Zwei Zeilen.

**A2 — Rechner als Hauptmenüpunkt.** Zweimal angewiesen. Halbfertig:
Pfad `/settings/computers` und Label existieren, die ROUTE fehlt →
zwei Typfehler in `SettingsSidebarNav.tsx:136,155`. Es fehlt
`apps/web/src/routes/settings.computers.tsx`, das die Computers-Sektion
rendert (Muster: `settings.workjet.tsx` mit `defaultSection="computers"`
— die äußere `WorkjetSettings` muss die Prop durchreichen, heute tut sie
das nicht: sie ruft `WorkjetSettingsView` ohne `defaultSection` auf).

**A3 — Fünf Reiter wie Swift.** Vorlage (`SettingsView.swift:12-16`):
`Prompt · Anbieter · Computer · Telemetrie · Ausführung`. Ist: neun
(`Workers · Computers · Provider accounts · LLM routes · Prompt ·
Telemetry · Execution · Capabilities · Legacy import`).
Ziel nach Betreiber-Ansage: Worker-Bereich = **Worker konfigurieren**;
Computers wandert auf die Hauptebene (A2), Provider accounts + LLM routes
gehören zu Models, Capabilities in den Worker-Editor, Legacy import
bleibt bis zur Ausführung sichtbar. Warum offen: ich habe die
Swift-Reiter ausgelesen und dann nichts damit gemacht.

## 2 · Composer-Leiste: ZWEI Modi, nichts vermischt

Ansage des Betreibers, wörtlich rekonstruiert:

**Worker-Modus:** `Worker · Rechner · Extras` — sonst NICHTS. Harness,
Provider, Modell, Reasoning stecken im Worker. Erlaubnis immer voll,
also kein Wähler.

**Manueller Modus:** `Harness · Provider · Modell · Rechner · Extras ·
eigener System-Prompt`. Erlaubnis ebenfalls immer voll.

Ist-Zustand: die alte Leiste + eingeschobener Worker-Wähler, zeigt beide
Modi GLEICHZEITIG (`GPT-5.6-Luna | Codex Prüfworker | Medium | Full
access`). Vom Betreiber zu Recht als Farce bezeichnet.

Teilarbeiten, die stehen: Worker-Wahl stellt Anbieter+Modell+Effort um
(`87e23eca5`, `6d489b5c7`); Extras-Menü bietet den Katalog (`6d1d6e70a`).

FERTIG heißt: Moduswechsel-Element; im Worker-Modus verschwinden
Modell/Reasoning/Full-access; im manuellen Modus erscheinen Harness,
Rechner, System-Prompt; „Full access"-Wähler ist in BEIDEN Modi entfernt
(B2 — war eine Anweisung, keine offene Frage; meine
„OWNER-4"-Deklaration war eine Ausrede).

Offene Sachfrage für Rechner in der Leiste (B3): ob ein Entwurf die
Ziel-Umgebung wechseln kann. `composerDraftStore` trägt `environmentId`;
nie zu Ende geprüft.

## 3 · Import der 12 Swift-Worker (C1)

`~/Library/Application Support/Workjet/config.v1.json` → Angebot in
Settings → Workjet → Legacy import. Läuft GENAU EINMAL; Stand:
1/14 beantwortet, nichts übernommen, Angebot offen.

Sichere Zuordnung (vom Betreiber unwidersprochen):

- Computer Local → `385a20df… (this server)` ✓ bereits gewählt
- gpu3-a4500, gpu1-a6000 → **Do not import** (nur „this server" wählbar;
  Remote-Worker unumkehrbar auf localhost zu biegen wäre falsch)
- Kimi 1 → Gateway-Konto Kimi · MiniMax 1 → MiniMax ·
  OpenAI 1+2 → Codex-Konto · Z.ai 1+2 → Z.ai · xAI → Do not import
  (kein Gateway-Konto vorhanden)

Warum offen: dreimal vertagt, dann Skriptfehler — es klickte immer das
ERSTE „Choose…" statt der Reihe nach (die Optionslisten der
Provider-Zeilen zeigen Umgebungs-IDs statt Gateway-Konten: das war die
Computer-Zeile). Je Datensatz einzeln öffnen und wählen, nach jedem
Schritt den Zähler prüfen.

## 4 · Prompt-Seite fertig nach Vorlage (B5)

Abschnitts-Zerlegung steht (`bfbb02db4`). Es fehlen gegenüber
`SettingsView.swift`: je Worker eine Karte mit Fakten-Chips
(Modell/Harness/Computer/Reasoning) und eigenem Bearbeiten, plus die
MODELL-Regeln (`modelPrompts` — in der Swift-Config 7 Einträge) einmal
je Modell unter dem ersten Worker dieses Modells. Das Datenmodell hier
kennt `modelPrompts` NICHT — vor dem Bau klären, ob es beim Import
mitkommt oder wo es leben soll.

## 5 · Z.ai/MiniMax-Modell-IDs eintragen (D2)

Feld existiert (`07bfa3735`), Inhalt fehlt. Modell-IDs stehen in der
Swift-Config (`providers[].modelIDs`): Z.ai `glm-*`, MiniMax
`MiniMax-M*`. Eintragen, „Save pools", dann ein echter Turn je Anbieter.

## 6 · Sign-in-Ablauf übersichtlich (A4)

Nie angefasst. Erst NACH E1 sinnvoll bewertbar, denn heute funktioniert
der Browser-Login für keinen Anbieter (gemessen: „The Workjet provider
gateway login flow is unavailable" auch bei Antigravity). Bis dahin ist
jeder UI-Umbau hier Kosmetik an einem toten Pfad.

## 7 · CLIProxy-OAuth verdrahten (E1) — das große Stück

Das Rust-Crate (`native/provider-gateway`) ist eine CLIProxy-Portierung,
242/617 produktive Go-Dateien. Vorhanden und UNVERDRAHTET:
`internal/auth/{claude,codex,antigravity,xai}` (xAI = kompletter
Device-Flow inkl. `verification_uri_complete`).
`ManagementProviderOAuthAuthority` (Trait in
`auth_files_provider_oauth.rs:88`) hat KEINE produktive Implementierung —
nur Trait, Export, ein Test. Deshalb wirft der Server bei jedem
OAuth-Begin `oauth-unavailable` (`ProviderGatewayService.ts:749`).

Nötig: produktive Authority über den vier Auth-Modulen (`begin` liefert
Auth-URL bzw. `verification_uri_complete`; `poll`; `cancel`), Anschluss
an die Management-Routen, Host neu bauen und in
`~/.t3/userdata/provider-gateway-host` bringen, dann Vertrag
(`WorkjetGatewayOauthProvider` + `"xai"`), Server-Route, Oberfläche.

Methoden-Warnung: Binär-`strings` sagt über vorhandene Routen NICHTS
(`model-definitions` fehlt dort als Literal und funktioniert). Nur echte
Aufrufe zählen.

## 8 · Grok-Abo-Login (E2)

Reine Folge von 7. Vorher wäre jeder Knopf eine Attrappe. Nach 7:
`"xai"` in `WorkjetGatewayOauthProvider`, `OAUTH_BEGIN_ROUTES`
erweitern, Karte von „Add API key" auf beides umstellen.

---

## Aufräumposten

- Prüf-Konfiguration des Assistenten entfernen, wenn nicht mehr
  gebraucht: Computer „MacBook Pro von Michael (2)", Route
  „Codex (OpenAI)", Worker „Codex Prüfworker".
- `docs/kundenpipeline-brille-plan.md` ist untracked (fremder Strang) —
  nicht anfassen.
- Stash `wip: package 9 option A (WorkerDispatch delegation)` liegt
  benannt im Stash; gehört zum Workjet-Plan-Strang, nicht hierher.
