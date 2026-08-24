# CTOX Desktop — offene Korrekturen

Stand 2026-08-24, aus dem Chat-Abgleich mit dem Betreiber. Jede Position
nennt: was fehlt, warum es bisher fehlt, was FERTIG konkret bedeutet.
Reihenfolge = Abarbeitungsreihenfolge. Erledigtes wird hier gestrichen,
nicht gelöscht.

Verwandt: [ctox-desktop-board.md](ctox-desktop-board.md) trägt die
erledigten Arbeiten dieser Sitzung, die Environment-Fallen und die
Fehlermuster. Dieses Dokument trägt NUR das Offene.

---

## -1 · SCHWERSTER BEFUND: Harnesses laufen im privaten Nutzerzustand

Gemessen 2026-08-24: Ein CTOX-Chat erschien in der Codex-Desktop-App.
Mechanismus, mit Code:

- `CodexHomeLayout.ts:40` — ohne `homePath` fällt CTOX auf `~/.codex`
  zurück, den PRIVATEN Codex-Zustand des Betreibers.
- `CodexHomeLayout.ts:19` — `KNOWN_SHARED_DIRECTORIES` enthält
  `"sessions"`: jede CTOX-Sitzung landet in `~/.codex/sessions`, das die
  Codex-Desktop-App anzeigt. Auch der Overlay-Modus (`shadowHomePath`)
  teilt Sitzungen weiter (schattiert nur log/memories/tmp).
- Analog Claude: der Harness nutzt die private CLI-Anmeldung
  (`~/.claude`), deren totes Token die App tagelang blockierte.

Das Original hat es andersherum gebaut (`Defaults.swift:224`):
`codex … exec --ignore-user-config --ephemeral` plus eigener Provider via
CLIProxy (`model_providers.workjet.base_url`, `requires_openai_auth=false`).
Harness = reiner Motor, keine Spur im Nutzerzustand, kein natives Login.

FOLGE für die Leiste (Betreiber-Hinweis 2026-08-24): Der Thread-Lock
("… is unavailable in this thread. Start a new thread to switch
providers") ist KEIN korrektes Verhalten, sondern ein Symptom dieser
Architektur — die Sitzung gehört dem CLI, also ist sie an dessen Harness
genagelt. Gehört die Sitzung der App (Original-Modell: Verlauf in der
App, Turn als Brief an einen austauschbaren Motor), sind Harness, Modell
und Rechner PRO TURN wechselbar. Die Zwei-Modi-Leiste (Posten 2) setzt
also Posten −1 voraus, sonst bleibt der Wechsel mitten in der Session
unmöglich.

FERTIG heißt: Harness-Sitzungen laufen in einem CTOX-eigenen Zustands-
verzeichnis (Codex: eigenes `CODEX_HOME` bzw. `--ephemeral` für
Einmal-Läufe; Claude: eigenes `CLAUDE_CONFIG_DIR`), Zugangsdaten kommen
über das Gateway-Routing statt aus dem nativen Login, und ein Turn aus
CTOX erscheint in KEINER anderen App. Achtung Migrationsfrage: bestehende
Threads referenzieren Sitzungen im alten Ort; Kontinuität klären, bevor
der Standard kippt.

## 0 · Gateway-Routing Claude — ERLEDIGT 2026-08-24, Ende-zu-Ende belegt

    user      :: Antworte ausschliesslich mit dem Wort BEREIT.
    assistant :: BEREIT          state=completed · 12,8 s

Claude Fable 5, gestreamt durch den CLI-Proxy, über das Gateway-Konto —
das tote native CLI-Token ist nicht mehr beteiligt. Damit ist auch der
Kern von Posten 7 gebaut: `ClaudeMessagesClaudeHandler` bedient
`/v1/messages` aus dem Claude-Subscription-Pool (Passthrough, kein
Übersetzer), Stream-Relay inklusive; Host neu gebaut und getauscht
(Backup: `provider-gateway-host.backup-aug20`).

ZWEI-ROUTER-FALLE (Folgearbeit): Konto-Modelllisten matcht der HOST
exakt (leer = alles), die App-Seite versteht `*`-Muster. Ein
Wildcard-Eintrag ent-routet das Konto hostseitig. Konten tragen jetzt
exakte IDs (claude-fable-5[1m] etc.). Die Semantiken gehören vereinheitlicht.

### (Diagnoseweg) Gateway-Routing Claude — Ursache gefunden

Gemessen in dieser Reihenfolge:

1. `routeViaGateway=true` gesetzt → der Turn-Fehler wechselte von
   „Failed to authenticate" zu „issue with the selected model
   (claude-sonnet-5)". Das Routing GREIFT also.
2. Direkter POST auf den Provider-Port des laufenden Hosts:
   `http://127.0.0.1:59770/v1/messages` → **404 „route not found"**
   (anthropic-förmig), mit und ohne `X-CTOX-Provider`-Header, ebenso
   `/v1/responses`-Varianten.
3. Im QUELLCODE existiert die Route (`internal/api/server.rs:362`,
   `dispatch_messages_request`). Der laufende Host (Build 2026-08-20)
   bedient sie nicht.

Ursache also NICHT Modellauflösung, sondern: **die laufende
Host-Binärdatei serviert die Anthropic-Messages-Route nicht.** Der
Claude-CLI bekommt 404 und meldet generisch „issue with the selected
model".

IN ARBEIT: Host aus dem aktuellen Quellstand bauen
(`cargo build --release --bin workjet-provider-gateway`), Binärdatei in
`~/.t3/userdata/provider-gateway-host` tauschen, App neu starten,
denselben Claude-Turn wiederholen. Das ist zugleich der erste Schritt zu
Posten 7 (gleiche Binärdatei).

### (ursprünglich) 0 · Sofort prüfen: bringt Gateway-Routing Claude zurück?

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

## 2b · UI/UX-Generalabgleich gegen die Swift-Vorlage

Vom Betreiber mehrfach moniert („wie eine Debug-Konsole", „abenteuerlich
dumm umgesetzt", „Farce") und in dieser Liste bisher NICHT als eigener
Posten geführt — nur einzelne Seiten wurden repariert (Models `dfac8d911`,
Pools `e3a05d6a9`, Worker-Editor `087cea464`, Prompt teilweise
`bfbb02db4`). Der Rest wurde nie gegen das Original gehalten.

Regel für JEDE Oberfläche (Lehre aus Fehlermuster Nr. 1): ERST die
Swift-Ansicht in `~/Documents/claude-workjet/app/Sources/WorkjetApp/`
öffnen, DANN bauen. Nicht aus dem Vertragsschema raten.

Noch nie gegen die Vorlage geprüft:

- **Sign-in-Ablauf je Anbieter** — Vorlage `ProviderAccountsView.swift`
  (verifiziert: Zeile 260 trägt je Zugang „Neu anmelden" bzw. „Schlüssel",
  je nachdem ob der Zugang über den Gateway-Login läuft) — heute
  verteilte Knöpfe mit Fortschritts-Prosa; A4/Posten 6.
- **Workjet-Reiterleiste** — neun flache Reiter ohne Hierarchie; Swift
  hat fünf mit klarer Aufgabenteilung (A3/Posten 1).
- **Computers-Editor** — Formular mit sechs Harness-Zeilen samt
  „Optional executable override"-Feldern; Swift zeigt Chips + Live-Status
  („Claude Code: Version 2.1.226 installiert." + Aktualisieren/Entfernen).
- **LLM-Routes-Seite** — Erklärprosa über drei Absätze, Auswahl zeigt
  rohe UUIDs (`385a20df-… (this server)`); Swift zeigt sprechende Namen.
- **Legacy-Import** — 14 Entscheidungen als endlose Liste mit
  Roh-Hashes (`CLIProxy account-7dceb07fa…`); keine Gruppierung, keine
  Vorbelegung sicherer Antworten.
- **Telemetry/Execution/Capabilities** — nie angesehen.
- **Durchgängig:** rohe IDs und Hashes im Sichtbereich, Erklärabsätze
  statt Zustand, Wiederholung derselben Information, transiente
  Meldungen dauerhaft im Layout (die Muster aus D5/T4, aber nur auf zwei
  Seiten behoben).

FERTIG heißt: jede Seite hat einen Screenshot-Vergleich gegen die
Swift-Entsprechung ODER eine begründete bewusste Abweichung; keine rohe
UUID/Hash im Standard-Sichtbereich; keine Erklärprosa, wo ein Zustand
stehen kann.

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

## 4 · Prompt-Seite — Aufgaben-Hälfte ERLEDIGT 2026-08-24

Worker-Aufgaben sind auf der Prompt-Seite bearbeitbar (Speichern bei
Blur ins Worker-Profil; live verifiziert bis in settings.json). OFFEN
bleibt die Modellregeln-Hälfte (`modelPrompts`): das Datenmodell kennt
das Feld nicht, und Speicher dafür zu erfinden wäre der
Zwei-Ziele-für-eine-Quelle-Fehler. Entscheidung gehört zum Import.

### (ursprünglich) Prompt-Seite fertig nach Vorlage (B5)

Abschnitts-Zerlegung steht (`bfbb02db4`). Es fehlen gegenüber
`SettingsView.swift`: je Worker eine Karte mit Fakten-Chips
(Modell/Harness/Computer/Reasoning) und eigenem Bearbeiten, plus die
MODELL-Regeln (`modelPrompts` — in der Swift-Config 7 Einträge) einmal
je Modell unter dem ersten Worker dieses Modells. Das Datenmodell hier
kennt `modelPrompts` NICHT — vor dem Bau klären, ob es beim Import
mitkommt oder wo es leben soll.

## 5 · Z.ai/MiniMax-Modell-IDs — EINGETRAGEN 2026-08-24, Turn offen

Gespeichert und verifiziert (`provider-gateway.json`): Z.ai 4 Modelle
(`glm-5.3, glm-5.2, glm-5.1, glm-5`), MiniMax 8 (`MiniMax-M3 …`), aus
der Swift-Config übernommen. Dabei zwei eigene Defekte gefunden und
behoben: `models` fehlte in der Dirty-Prüfung (`54e7a73df` — Save blieb
grau) und die Pool-Zeile versteckte Konto-Modelle hinter „no gateway
catalog" (Zeile liest jetzt „4 account models").

WICHTIGE LEHRE dabei: Der Backend läuft aus `apps/server/dist/bin.mjs`
(`vp pack`, NICHT `vp build`). Server-Quelländerungen sind erst nach
`vp pack` + App-Neustart wirksam — der erste Speicherversuch ging durch
einen alten Server und verwarf `models` stumm. In die
Environment-Fallen des Boards übernommen.

OFFEN: der echte Turn je Anbieter. Er braucht einen durch den Gateway
gerouteten Harness, der diese Modelle anpinnen kann — blockiert durch
die Modellauflösung aus Posten 0/−1 (der Wähler bietet je Harness nur
dessen eigene Modelle an).

## 6/7 · KORREKTUR 2026-08-24: Der OAuth-Login FUNKTIONIERT mit dem neuen Host

Gemessen nach dem Host-Tausch: „Add another" auf Claude antwortet

    Finish the Claude login in your browser, then return here.
    Login session e4d9…61c4. Workjet never sees your credentials.

Die produktive `ManagementProviderOAuthAuthority` lebt im HOST-Crate
(`provider-gateway-workjet-host/src/oauth.rs`, 1031 Zeilen,
anthropic/codex/antigravity) — mein Befund „keine produktive
Implementierung" galt nur für das Gateway-Crate und für die alte
Binärdatei vom 20.08. Antigravity scheitert weiterhin separat
(braucht eigene Client-Secrets in der Konfiguration).

Posten 8 (Grok), Umfang nach vollständiger Prüfung 2026-08-24:

- Login-Hälfte KLEIN: xai-Fall in `HostOAuthSource` (Device-Flow —
  `verification_uri_complete` als authorizationUrl, Hintergrund-Task
  pollt `poll_for_token` und schreibt das LoginOutcome, kein
  Callback-Port), `xai-auth-url`-Route, Vertrag, Karte.
- ABER die BEDIEN-Hälfte fehlt ganz: `XaiSubscriptionAuth` existiert im
  Gateway-Crate und wird von NIEMANDEM verbraucht — kein Executor, kein
  Pool, keine Runtime-Konfigurationssektion, kein Router-Eintrag (nur
  der eigene Test). Ein Abo-Login ohne diesen Pfad erzeugte Zugangs-
  daten, die nichts bedienen kann — dieselbe Attrappen-Falle, nur eine
  Ebene tiefer. Vergleichsgröße: der Claude-Pfad (Auth→Executor→Pool→
  Handler) ist tausende Zeilen.
- Reihenfolge daher: erst Bedien-Pfad (Executor+Pool+Config nach dem
  Claude-Muster, upstream-Form des Grok-Abo-APIs klären), DANN Login.

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
