# CTOX Desktop — offene Korrekturen

Stand 2026-08-24, aus dem Chat-Abgleich mit dem Betreiber. Jede Position
nennt: was fehlt, warum es bisher fehlt, was FERTIG konkret bedeutet.
Reihenfolge = Abarbeitungsreihenfolge. Erledigtes wird hier gestrichen,
nicht gelöscht.

Verwandt: [ctox-desktop-board.md](ctox-desktop-board.md) trägt die
erledigten Arbeiten dieser Sitzung, die Environment-Fallen und die
Fehlermuster. Dieses Dokument trägt NUR das Offene.

---

## -1 · Harness-Isolation — FÜR CLAUDE UND CODEX AKTIV seit 2026-08-24

Umgesetzt rein per Konfiguration (die Mechanik existierte):

- **Claude:** `homePath = ~/.t3/userdata/harness-homes/claude` →
  `CLAUDE_CONFIG_DIR` (ClaudeHome.ts), plus `routeViaGateway`.
  BEWIESEN: Turn `BEREIT` (14,6 s) übers Gateway; `~/.claude` blieb bei
  16 greppy-Sitzungen, die neue Sitzung liegt im CTOX-Home.
- **Codex:** `homePath = ~/.t3/userdata/harness-homes/codex` →
  `CODEX_HOME`, plus `routeViaGateway`. App-Server bootet im isolierten
  Home; `~/.codex/sessions` stabil bei 401 über mehrere Threads.
  Der volle Codex-Turn-Beweis wartet auf das Kontingent (27.08.).
  (Eine 401. Datei entstand VOR dem Neustart — Titel-Generierung lief
  noch mit altem Home; seit dem Instanz-Neuaufbau nichts mehr.)

ZWEI FALLEN dabei, beide teuer:

1. `providerInstances.codex` von Hand in settings.json zu schreiben
   KILLT den Default-Slot (Codex verschwand komplett aus Harness-Liste
   und Wähler). Instanzen NUR über das App-Formular anlegen; Rollback
   war nötig.
2. Konfigurationsänderungen wirken erst nach App-Neustart auf die
   Instanz — dazwischen schreibt z. B. die Titel-Generierung noch ins
   alte Home.

OFFEN an −1: Grok/OpenCode-Homes analog (OpenCode nutzt native
Anmeldung — Isolation dort erst mit Gateway-Route sinnvoll); und die
GROSSE Frage bleibt separat: Sitzungs-EIGENTUM in der App (Thread-Lock,
Wechsel mitten in der Session) — das ist die Migrationsentscheidung des
Betreibers, unverändert.

### (ursprünglich) SCHWERSTER BEFUND: Harnesses laufen im privaten Nutzerzustand

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

ZWEI-ROUTER-FALLE — GESCHLOSSEN 2026-08-24: Der Host-Scheduler versteht
jetzt dieselben verankerten `*`-Muster wie die App-Seite
(`model_entry_matches` in `sdk/cliproxy/auth/scheduler.rs`, mit Test).
Ende-zu-Ende belegt: Konten wieder auf `claude-*`/`gpt-*`/`kimi-*`
gestellt, Host neu gebaut und getauscht, App-Turn → BEREIT
(`state=completed`, 10,4 s).

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

## 2 · Composer-Leiste — WORKER-MODUS KOMPLETT 2026-08-24

Live: `MacBook Pro von Michael (2) | Codex Prüfworker | Current checkout`
— Rechner (aus dem Worker-Profil) · Worker · Checkout; Modell/Effort
verschwinden (der Worker bündelt sie), Extras wendet der Thread-Start
aus dem Profil an (ein Dispatch, Standard wird überschrieben), „Full
access" ist entfernt. Der Rechner ist bewusst noch KEIN Umschalter: mit
einer Umgebung wäre ein Ein-Options-Dropdown eine Attrappe; Naht für
später = Projekt-Umgebung des Drafts. NUR noch an −1 gebunden: Wechsel
MITTEN in der Session (Sitzungs-Eigentum).

Live belegt: Worker-Modus zeigt `Worker | Checkout` (Modell und Effort
verschwinden — der Worker bündelt sie); Manual bringt beide zurück.
„Full access" ist in beiden Modi entfernt (B2). OFFEN: Rechner- und
Extras-Element im Worker-Modus (Extras existiert bislang nur auf
Server-Threads), Harness/System-Prompt im manuellen Modus, Wechsel
MITTEN in der Session (hängt an −1: Sitzungs-Eigentum).

### (ursprünglich) Composer-Leiste: ZWEI Modi, nichts vermischt

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

## 2b · UI/UX-Generalabgleich — drei Flächen erledigt 2026-08-24

- **Routen-Zeile**: Konto-LABEL statt Roh-Hash (`2577747cd`); deckte
  sofort einen echten Datenfehler auf (Route „Codex (OpenAI)" zeigte
  aufs Claude-Konto; korrigiert).
- **Computers-Liste**: je Computer eine Zeile pro Harness mit Live-Punkt
  und Detail aus `workjet.harness.inspect` (`540841518`) — der Zähler
  „0 harnesses marked available" ist weg; fremde Umgebungen zeigen den
  deklarierten Stand ehrlich als „not probed from here".
- **Import**: 14/14 vorbelegt (s. Posten 3).

Weitere Abgleiche 2026-08-24:

- **Telemetry/Execution vs. Swift**: deckungsgleich bis auf
  „Gleichzeitige Aufträge" (`providerSlots` 1–3). Das Feld fehlt im
  Vertrag UND hätte hier keinen Verbraucher — Speicher ohne Verbraucher
  wäre eine Attrappe. Erst Slot-Begrenzung im Ausführungspfad bauen,
  dann das Feld.
- **Computers-EDITOR**: Override-Eingaben hinter `details` gefaltet,
  Verfügbarkeit führt (wie Swift); ein GESETZTER Override bleibt offen
  sichtbar.

ERLEDIGT 2026-08-24: Worker-`capabilityIds` werden beim Übergang
Draft→Server-Thread angewendet — EIN Dispatch mit der exakten Liste
(`executeWorkjetCapabilitySet`; Per-Id-Toggles verlöre der
In-Flight-Guard). Live belegt: Worker ohne Extras → Tools-Menü des
gestarteten Threads liest Greppy/Web Search/Web Stack Browser = false,
der Greppy-Standard korrekt überschrieben. OFFEN bleibt der RECHNER im
Worker-Modus (Draft-Umgebungswechsel, eigene Naht).

### (ursprünglich) UI/UX-Generalabgleich gegen die Swift-Vorlage

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

## 3 · Import — VORBEREITET 2026-08-24: 14/14 vorausgewählt, ein Klick übrig

Die Seite kommt jetzt mit allen 14 Antworten vorbelegt an (live geprüft:
„Records that need you (14/14 answered)", null offene Auswahlfelder).
Die Vorbelegung folgt der dokumentierten sicheren Zuordnung und ist
konservativ (nur Eindeutiges; Mehrdeutiges bleibt offen; unlesbarer
Katalog belegt nichts). **„Import once" bleibt unberührt — dieser eine
Klick gehört dem Betreiber**, samt Prüfblick auf die vorbelegten Werte
(gpu3/gpu1/xAI stehen auf „Do not import this").

### (ursprünglich) Import der 12 Swift-Worker (C1)

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

## 6 · Sign-in — KERN ERLEDIGT 2026-08-24

Der Login funktioniert (Browser-Handoff, s. u.), und die Swift-Vorlage
ist übernommen: **„Re-login" sitzt am Zugang selbst** (`462f9d6e7`, live:
beide OAuth-Konten tragen den Knopf), statt dass der Betreiber wissen
muss, dass „Add another" mit derselben Identität den Zugang heilt.
API-Key-Zugänge behalten ihr Schlüssel-Formular. OFFEN: Antigravity
braucht Client-Secrets (Betreiber).

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
- KORREKTUR 2026-08-24 (zweite Messung): „kein Executor" war FALSCH.
  Die gesamte xai-Executor-Familie IST portiert
  (`xai_executor{,_execute,_stream,_tokens,_media,_request,_response}.rs`
  plus Reasoning-Replay-Cache und Websockets) — Grok-`/responses`-Form
  nativ. Mein Grep suchte nur nach „XaiSubscription" und übersah sie.
- Was WIRKLICH fehlt: der Subscription-POOL nach dem Muster der anderen
  (`XaiSubscriptionAccountPool` analog Claude/Codex/Antigravity), ein
  Responses-Handler darüber, die Host-Konfigurationssektion für
  xai-OAuth-Konten, der Device-Flow-Fall in `HostOAuthSource`,
  `xai-auth-url`-Route, Vertrag, Karte.
- E2E-Schlussprüfung braucht den BETREIBER: der Device-Flow verlangt
  seine Anmeldung im Browser. Bau und Unit-Verifikation gehen vorher;
  „bewiesen" gibt es erst nach seinem Login.

BAUANLEITUNG (Vorlagen 2026-08-24 verifiziert; Reihenfolge = Gates):

1. `internal/runtime/executor/xai_subscription_pool.rs` — Pool über
   `XaiExecutor` (existiert, spricht Grok-`/responses` nativ) +
   `XaiSubscriptionAuth.refresh(auth)→Auth` (xai_executor_auth.rs:65).
   Auth-Konstruktion: `metadata.access_token`/`base_url` — genau was
   `xai_credentials` (xai_executor_request.rs:63) liest. Modell-Wahl mit
   `model_entry_matches` (Wildcard-Semantik, scheduler.rs). Refresh bei
   401, ein Retry. Vorlage klein: `ApiKeyAccountPool`
   (openai_responses_api_key_handlers.rs:121, ~120 Zeilen) — NICHT das
   2383-Zeilen-Antigravity-File spiegeln; Credits/Fingerprints entfallen.
   GATE: Unit-Tests Pool-Auswahl + Refresh-Pfad.
   → ERLEDIGT 2026-08-24: Pool + Tests gebaut, beide Tests grün
   (`cargo test --lib xai_subscription`: refresh-einmal-und-persistiere,
   Wildcard-Auswahl). Zwei Vorlagen-Fakten, die die Tests erzwangen:
   Grok-`/responses` antwortet auch ohne `stream` als SSE (`data:`-Frames,
   `aggregate_responses_sse`), und der Default-base_url-Parameter von
   `XaiSubscriptionAuth::new` MUSS gesetzt sein — ein leerer landet im
   refreshten Auth und lässt den Retry an `InvalidTarget` sterben.
2. `OpenAiResponsesXaiHandler` im selben Muster wie der ApiKey-Handler
   (parse model/stream → pool → Stream-Pumpe). GATE: cargo test.
   → ERLEDIGT 2026-08-24: `openai_responses_xai_handlers.rs` + Router-Feld
   `with_xai` (Subscription schlägt für "xai" die API-Key-Map, ohne sie zu
   verdrängen), Enum-Variante `XaiStream`, Server-Writer-Arm OHNE
   Extra-Delimiter (xai-Frames kommen KOMPLETT inkl. Terminator — anders
   als die Translator-Pfade). Gepufferte Antworten entpacken das
   aggregierte `response.completed`-Event zum Response-Objekt.
   GATE grün: volle Suite 2532 lib-Tests ok, 4 neue Handler-Tests ok.
3. Host `src/config.rs`: Sektion `xai_accounts` (Secrets-Refs wie
   claude_accounts); `src/runtime.rs`: Pool bauen, im
   `OpenAiResponsesProviderRouter` als "xai" registrieren, Summary-Zeile.
   GATE: Host baut, `runtime-status` zeigt xai.
   → ERLEDIGT 2026-08-24: `xai_accounts`-Sektion in CliproxyRuntimeConfig
   (access+refresh Secret-Refs, optionale base_url/token_endpoint/proxy),
   Produktions-Transport `XaiSubscriptionHttpTransport` (wreq, Feature
   xai-http-transport; execute + stream + Token-Refresh mit Discovery),
   Host: Pool-Bau + Persist-Port (rotierter Refresh-Token → Secret-Store,
   write_text) + Router `with_all_handlers` (default "xai" auch ohne
   API-Key gültig) + Summary-Zeile (Subscription und API-Key teilen die
   "xai"-Zeile) + Modellkatalog. GATE grün per Boot-Test: echter Host
   startet mit xai-Subscription als Default, runtime-status zeigt
   active_provider=xai, runtime-config listet die xai-Zeile, /v1/models
   führt das Modell, kein Token erscheint auf einer Fläche; fehlendes
   Secret schlägt vor jedem Bind fehl. Suiten: Gateway 2532 ok, Host 16 ok.
4. Login: `HostOAuthSource` „xai"-Fall — begin = `start_device_flow`,
   authorizationUrl = `verification_uri_complete`, KEIN Callback-Port;
   stattdessen Hintergrund-Task `poll_for_token` → LoginOutcome (Muster:
   die Callback-Task-Enden in oauth.rs). Identität aus
   `parse_jwt_identity`. Secrets: access+refresh wie anthropic.
   → ERLEDIGT 2026-08-24: HostOAuthAuthority-"xai"-Arm — begin blockt
   kurz in place (multi-thread Runtime) für discovery+device-code, gibt
   `verification_uri_complete` als authorizationUrl zurück, KEIN
   Callback-Listener; Hintergrund-Task `wait_for_authorization` →
   LoginOutcome (Refresh-Token PFLICHT, sonst sichtbarer Fehler);
   Abbruch über `device_polls`-Cancellation (cancel + poll-Terminal).
   Neuer Produktions-Login-Transport `XaiLoginHttpTransport` (wreq) im
   Gateway. UNGEPRÜFT offline: begin("xai") braucht das Netz — der
   Live-Beweis (verification-URL, Poll pending) ist das Gate von
   Schritt 5, der Login selbst das Betreiber-Gate von Schritt 6.
5. Vertrag `WorkjetGatewayOauthProvider`+`"xai"`, Server
   `OAUTH_BEGIN_ROUTES`/`HOST_PROVIDERS`, Management-Route
   `xai-auth-url` (server_management.rs neben den drei vorhandenen),
   UI-Karte: xAI bekommt BEIDE Knöpfe (Add account + Add API key).
   GATE: „Add account" liefert die verification-URL, Poll „pending".
   → CODE ERLEDIGT 2026-08-24: Route xai-auth-url (Rust), Vertrag
   WorkjetGatewayOauthProvider+"xai", OAUTH_BEGIN_ROUTES/HOST_PROVIDERS/
   REQUIRED_SECRET_KEYS/persist-Zweig (Service), Konfig-Schema
   XaiSubscriptionGatewayAccount (Feld-basiert von API-Key-Konto
   unterschieden, xai_accounts-Übersetzung ohne weight), xAI-Karte mit
   BEIDEN Knöpfen. Typecheck server+web grün, Config-Tests 17/17.
   Live-GATE GRÜN 2026-08-24 ~09:05: Deploy (Server-Bundle, Web,
   Host-Binary getauscht+signiert), xAI-Karte zeigt beide Knöpfe,
   "Add account" startete den Device-Flow real — UI: "Finish the xAI
   (Grok) login in your browser… Login session 9bdd…7124", Poll pending.
   Schritt 6 (Login-Abschluss im Browser) liegt beim BETREIBER — die
   Session läuft, "Cancel login" ist sichtbar.
6. BETREIBER-GATE: Device-Login abschließen, dann Grok-Modell anpinnen
   und Turn fahren.

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

## 9 · Betreiber-Meldungen 2026-08-24 (Nachmittag) — NEU, aus Screenshots

Alle sechs direkt aus Chat-Nachrichten mit Screenshots übernommen:

1. Sign-in-Landing-Page war ungestylter Text mit "return to Workjet" →
   ERLEDIGT im Code (loopback.rs: gestaltete Karte, hell/dunkel,
   "CTOX Desktop App", Erfolg grün / Fehler rot). NOCH ZU TUN:
   Host-Release bauen + Binary nach ~/.t3/userdata tauschen (codesign!).
2. Re-login erzeugt DOPPELTE Accounts (Claude 2×, Codex 2× im
   Screenshot). Ursache: persistClaimedAccounts pusht immer neu.
   FIX: gleiche Identität (Provider+Label) → Secrets der bestehenden
   Referenzen überschreiben, keinen neuen Account anlegen.
3. Accounts sind NICHT löschbar. FIX: Remove-Aktion je Account
   (RPC + Konfig-Schreiben + Secrets löschen + Gateway-Reload) + UI.
4. "Wo sind die unterstützten Modelle?" — Login-Accounts entstehen mit
   models:[] (Host-record() liefert leer). FIX: Provider-Defaults beim
   Anlegen (claude→claude-_, codex→gpt-_/codex-_, xai→grok-_) und
   bestehende leere Accounts heilen.
5. Refresh-Knopf auf der LLM-providers-Seite tut scheinbar nichts →
   diagnostizieren (was ruft er, was ändert sich sichtbar?).
6. Settings-Menü "Computers" zeigt die WORKJET-Seite (Workers-Tabs,
   Greppy Runtime) statt einer Computers-Seite → Navigation/Inhalt
   korrigieren.
7. "Wo sind die default worker aus der Swift-App?" — ERLEDIGT direkt:
   Import-UI gelöscht, die 12 Worker aus config.v1.json direkt angelegt
   (live verifiziert: alle 12 auf der Worker-Seite sichtbar), dazu
   Computer gpu3-a4500/gpu1-a6000 (Environment noch unpaired — nach
   dem Pairing im Editor zuweisen) und Routen Kimi/MiniMax/Z.ai/xAI.
   Duplikat-Accounts (Claude/Codex je 2×) zusammengeführt — die
   FRISCHEN Tokens der Re-Login-Duplikate auf die Originale kopiert,
   Duplikate + deren Secrets entfernt (Backups liegen neben den
   Dateien). Live: 5 Accounts, je 1 pro Provider, Remove-Knöpfe da.
8. "Warum gibt es noch Connections, wenn es Computers gibt?" — zwei
   Menüpunkte fürs selbe Konzept (Remote environments pairen = Rechner
   hinzufügen). FIX: Connections-Inhalte (Network access, Tailscale,
   Remote environments) in die Computers-Seite integrieren, Menüpunkt
   Connections entfernen.
9. Legacy-Import-Seite: "lösch das sofort. Du solltest nur die worker
   aus workjet neu anlegen!!!!" — FIX: Import-UI komplett entfernen;
   stattdessen die 12 Swift-Worker (config.v1.json, 12 workers,
   3 computers gelesen 2026-08-24) direkt als Worker anlegen samt
   Computern gpu3-a4500/gpu1-a6000; Local → dieses Environment.
10. Prompt-Tab zeigt nicht den GESAMTEN Worker-Prompt wie die
    Swift-App (dort: Karte je Worker mit Badges + MODELL-Regeln +
    WORKER-AUFGABE voll ausgeschrieben). FIX: Prompt-Seite baut die
    vollständige Ansicht nach; Modellregeln (modelPrompts) importieren.
11. Manual-Modus: Harness/Modell-Trennung fehlt weiter — Screenshot
    zeigt den alten Provider-Tab-Modellpicker ("No models found") statt
    Harness · Provider · Modell als getrennte Auswahlen.
12. In BEIDEN Modi fehlt die Rechner-AUSWAHL in der Leiste (nur
    Anzeige). Funktional fehlt damit auch: einen Thread auf einen
    anderen PC schieben.
13. App-Neustart fordert Re-Login bei allen Providern ("Codex is
    unauthenticated · Sign in via the CLI", "Updates Available: 3
    providers"). Gateway-geroutete Instanzen dürfen NIE einen
    CLI-Login verlangen — Auth kommt vom Gateway. Statusprüfung
    korrigieren.

## Stand nach Deploy 2026-08-24 ~09:10

LIVE VERIFIZIERT (CDP, frisch gestartete App):

- 12 Swift-Worker auf der Worker-Seite sichtbar; Import-UI komplett weg.
- Models-Seite: 5 Accounts (je 1 pro Provider), 5 Remove-Knöpfe,
  xAI-Karte mit "Add account" UND "Add API key".
- xAI "Add account" startet den Device-Flow real (Session-Anzeige,
  Cancel möglich) → Schritt-5-Gate GRÜN; Browser-Login = Betreiber.
- "Codex is unauthenticated"-Banner nach Neustart: WEG (Punkt 13).
  IN ARBEIT (zwei Implementierungs-Subagents, eigene Worktrees):
- Settings-Umbau (16 Review-Befunde: echte Computers-Seite, Connections-
  Merge, Suche, tote Knöpfe, UUID-Lecks, roter Test).
- Composer-Umbau (14 Review-Befunde: Manual = Harness·Provider·Modell·
  Rechner·Extras, Rechner wählbar in beiden Modi, Worker-Modus pur,
  System-Prompt-Feld, worker.computerId/instructions wirken).
  OFFEN DANACH: Prompt-Seite mit vollen Worker-Prompts + Modellregeln
  (Swift modelPrompts), gpu-Computer nach Environment-Pairing zuweisen,
  Betreiber: Grok-Login.

## Stand nach zweitem Deploy 2026-08-24 ~10:00 — ALLES LIVE VERIFIZIERT

KRITIK-FUND dieser Runde: der Banner-Fix von heute Vormittag hatte
`message: undefined` in den Provider-Snapshot gelegt. Ein expliziter
undefined-Schlüssel ist kein JSON-Wert — der Client-Decode der
serverGetConfig-Antwort STARB damit ("Expected JSON value at
providers[1]"), die Environment-Verbindung fiel in eine Retry-Schleife
und die App lebte unbemerkt aus dem IndexedDB-Cache (deshalb wirkte
auch "Refresh" tot und neue Felder wie modelPrompts kamen nie an).
FIX: den Schlüssel ganz weglassen statt undefined. Beweiskette:
Wire-Sniff (JSON.parse-Hook), Server-Probe (in-memory 7 modelPrompts),
Defekt-Log im Supervisor. Probes wieder entfernt.

Nach dem Fix live geprüft (CDP):

- Verbindung stabil, kein Defect-Log, Live-Daten statt Cache.
- Prompt-Seite: alle Worker-Karten mit "MODEL RULES · <modell>"
  (Swift-Modellregeln, 7 Modelle, editierbar; geteilt je Modell) und
  vollem "WORKER TASK"-Text.
- Manual-Modus-Leiste: Codex CLI · Codex (OpenAI) · gpt-5.6-luna ·
  MacBook Pro von Michael (2) · Manual · Medium · System prompt —
  Harness/Provider/Modell/Rechner getrennt, System-Prompt-Feld da.
- Worker-Modus-Leiste nach Auswahl "Sol · Completion (Hard Tasks)":
  Worker · Rechner · Tools — sonst nichts.
- Computers-Seite: eigene Seite (h1 Computers), gpu3-a4500 gelistet,
  Remote-environments-Pairing integriert; Connections ohne Dopplung.
- Models-Seite: Accounts je 1×, Remove-Knöpfe, xAI beide Knöpfe.
- Kein "unauthenticated"-Banner.

OFFEN (Betreiber): Grok-Device-Login abschließen (Karte → Add account,
Browser-Freigabe), danach die Route "xAI (Grok)" auf den neuen Account
zeigen lassen (Models → LLM routes, 1 Klick — zeigt bis dahin ehrlich
"Account not in the gateway catalog (xai-grok-pending)").
OFFEN (später): gpu3/gpu1-Computer nach Environment-Pairing zuweisen;
managedSystemPrompt-Import aus Swift (composeManagedSystemPrompt)
entscheiden; Prüfworker-Aufräumposten.

## Nachtrag 2026-08-24 ~10:10 — Restposten über die Live-UI erledigt

- Globaler Workjet-Prompt aus der Swift-App importiert (27,5 KB:
  Orchestrator-/Skill-Regeln als Preamble, Progress board, Ad-hoc
  learnings, Technical rules) — über die Prompt-Seite der laufenden App
  gesetzt (kein Neustart), gespeichert bestätigt, Seite zeigt die vier
  benannten Sektionen. Modellregeln bleiben strukturell in
  modelPrompts (bewusst NICHT in den globalen Text dupliziert).
- Aufräumposten: "Codex Prüfworker" gelöscht — es stehen exakt die
  12 Swift-Worker in der Liste (persistiert verifiziert). Computer
  "MacBook Pro von Michael (2)" und Route "Codex (OpenAI)" bleiben:
  sie sind jetzt reguläre Ziele der eingerichteten Worker.

Verbleibende BETREIBER-Punkte (nicht von hier aus machbar):

1. Grok-Login: Models → xAI (Grok) → "Add account", Browser-Freigabe;
   danach Route "xAI (Grok)" auf den neuen Account zeigen (1 Klick).
2. gpu3-a4500/gpu1-a6000: Environments pairen (Computers-Seite,
   Remote environments), dann in den beiden Computer-Einträgen das
   Environment zuweisen.

## Nachtrag 2026-08-24 ~10:3x — "die Buttons machen nichts"

Ursache (gemessen): Die Editier-/Anlege-Editoren (Worker, Computer,
LLM-Route) mounteten ans LISTENENDE — bei 12 Workern lag der Editor bei
y≈1456 in einem 844px-Viewport. Der Klick FUNKTIONIERTE, das Ergebnis
war nur unsichtbar. FIX: Editor rendert jetzt direkt UNTER der
angeklickten Zeile (Add-Editor direkt unterm Kopf). Live verifiziert
per Screenshot (Sol-Editor voll sichtbar unter der Zeile; Computer-
Editor top=768 im 844px-Viewport). Der Pairing-Dialog (Add environment)
funktionierte bereits — er ist ein Modal.
Zusätzlich: claude-code/codex-cli auf "MacBook Pro von Michael (2)" als
verfügbar deklariert (die Live-Probe zeigt beide installiert) — die
"not marked available"-Warnungen der 10 lokalen Worker sind weg; übrig
bleibt die EHRLICHE Warnung des gpu1-Workers (Maschine unpaired).
LEKTION: statische Reviews finden solche Fehler nicht — interaktiver
Klick-Durchlauf in der laufenden App wird als eigener Review-Schritt
etabliert (läuft).

## Interaktiver UI/UX-Klick-Review 2026-08-24 ~10:45 — 6 Befunde, alle gefixt

Review-Methode: Subagent klickt die LAUFENDE App über CDP durch, prüft
sichtbare Konsequenz im Viewport (Rects, Hit-Tests, Screenshots),
Konsole überwacht (0 Fehler). Volle Abdeckungsliste im Agent-Bericht;
Harness-Skripte liegen wiederverwendbar im Session-Scratchpad (h.mjs,
s1…s8\*.mjs).

1. "Open Computers"-Link (Connections) warf in den Chat-Draft — roher
   href ohne Hash-Präfix im Hash-Router. FIX: #/settings/…-Hrefs (auch
   der Gegenlink auf der Computers-Seite). Live: landet auf h1 Computers.
2. Composer-Chipzeile: versteckter Overflow-Scroller ohne Affordance —
   Manual/Effort/System prompt unsichtbar hinter der Kante (scrollWidth
   1136 in 720px). FIX: Chips WRAPPEN statt zu clippen. Live: alle
   Chips im Viewport.
3. Models-Refresh "tot": WS-Refetch antwortet in Millisekunden, nichts
   sichtbar. FIX: Spinner mit Mindestdauer. Live: Spinner erscheint.
4. Info-Knopf "Background policy details": Hover-only-Tooltip, Klick
   ergebnislos. FIX: Klick-Popover statt Tooltip. Live: öffnet.
5. Löschen ohne Bestätigung (Worker/Route/Computer/Account): FIX:
   zweistufiger ConfirmingDeleteButton (erst "Delete?", 4s Auto-
   Entschärfung), an allen vier Stellen. Live: armiert + entschärft.
6. Kein sichtbares Feedback nach Save (Zeile unter dem Fold): FIX:
   Success-Toast bei Worker-/Computer-Save.

## Nachtrag 2026-08-24 ~13:05 — Pi Code auf der Harnesses-Seite

Meldung: "pi code fehlt bei den harnesses" (+ Korrektur: kein Logo,
falsche Beschreibung im ersten Wurf). Ursachen: (a) Pi Code hat keinen
Chat-Treiber, also keine Instanz-Karte; (b) die Harness-Probe
untersuchte NUR von Worker-Profilen referenzierte Harnesses — pi-code
tauchte im Snapshot nie auf. FIX: Probe deckt jetzt alle bekannten
Harness-Arten ab (jede Zeile bleibt echte Messung); die Harnesses-Seite
zeigt Pi Code als Karte im Stil der übrigen Runtimes (π-Glyphe in
currentColor — das CLI bündelt kein offizielles Markenzeichen —,
Status-Punkt, Versions-Chip, "Installed · available to Workjet
workers"). Live verifiziert per Screenshot: v0.80.2 grün in der Reihe.
Anmerkung: ein vollwertiger Pi-Code-CHAT-Treiber (Instanzen, Threads)
ist ein eigenes Projekt und bewusst nicht Teil dieses Fixes.

## 10 · Business-OS-Meldungen 2026-08-24 ~13:3x (Screenshots)

14. Instanz-Wechsel erzwingt jedes Mal einen kompletten Reload mit
    Ladescreen. SOLL: geladene Instanzen bleiben warm (Webview-Pool),
    Wechsel zwischen zwei geladenen Instanzen ist instant, ohne
    sichtbaren Ladescreen; nur der ERSTE Load darf dauern.
15. Kein farbiger Status-Punkt je Instanz, der "geladen/verbunden"
    anzeigt — alle Punkte grau. SOLL: Punktfarbe = Ladezustand, und
    geladene Instanzen sind instant wechselbar.
16. Instanzen in der Seitenleiste lassen sich nicht ein-/ausklappen
    (Klick auf den Instanznamen faltet den App-Baum nicht).
17. Business-OS hat keine eigene Menüleiste (Pendant zur unteren
    Icon-Leiste der Code-Seite fehlt).
    Dazu aus dem Chat: die untere Icon-Leiste der Code-Seite (Settings,
    Pull Requests, Usage, Machines, Refresh) muss nachweislich
    funktionieren — in die Klick-Verifikation aufgenommen.

## Nachtrag 2026-08-24 ~13:5x — Composer-Umbau Runde 2 (alle live verifiziert)

- NEUE Reihenfolge (Betreiber-Vorgabe): Reihe 1 = Modus (Worker/Manual)
  · Rechner · Harness · Modell; Reihe 2 = Modell-Settings (Effort) ·
  System prompt · Rest. Worker-Modus bleibt EINE Reihe (abgenommen:
  "schon clean, so soll das sein").
- Provider-Chip ENTFERNT: beim Gateway bestimmt das Modell den Account
  (Routing per Modellmuster) — das Modell-Menü gruppiert stattdessen
  nach Anbieter. T3-Mini-Menü mit Anbieter-Leiste ist als nächste
  Iteration notiert (aktuell gruppierte Liste mit Anbieter-Headern).
- Harness-Wahl ändert das MODELL nicht mehr: der Resolver klemmte auf
  die native Modellliste der Instanz (claude-fable-5-Rückfall).
  Gateway-geroutete Instanzen behalten das gewählte Modell wörtlich.
- Worker→Manual-Wechsel war TOT: das Menü ragte in die Electron-
  Titelleisten-DRAG-ZONE, die Klicks auf oberste Einträge schluckt
  (OS-Trefferfläche schlägt z-index). Fix: Portal-Ebenen (Popups,
  Menüs, Dialoge) global -webkit-app-region: no-drag. Live: Wechsel
  in beide Richtungen funktioniert.
- Dropdowns bekommen Anlege-Einträge: "+ Add worker…" im Worker-Menü,
  "+ Add computer…" im Rechner-Menü — springen in die Settings.
- Aufräumung Testthreads: viele gesettelt; übrig sind Failed-Threads
  und ein hängender Working-Thread (Settle verlangt erst
  Resolve/Interrupt) — Restaufräumung folgt.

Icon-Leiste unten links, live geklickt und verifiziert: Settings →
#/settings/general ✓, Pull Requests → #/pull-requests ✓, Usage →
#/usage ✓, Machines → #/machines ✓, Check for updates → läuft ✓.

OFFEN (nächste Iterationen, priorisiert):

1. Modell-Menü als T3-Mini-Menü (Anbieter-Leiste links, Modelle je
   Anbieter rechts) statt gruppierter Liste.
2. Business-OS 14–17: Instanz-Warmhalten/Instant-Swap, Status-Punkte,
   Ein-/Ausklappen, Menüleiste.
3. Rest-Testthreads: ERLEDIGT ~14:45 — der Weg war "Dismiss error" im
   Thread (Fehler quittieren), Stop beim laufenden, dann Settle.
   Live-Endstand: 0 offene Zeilen, kein Working, keine Failed-Badges.
4. Betreiber: Grok-Login, gpu-Pairing.

## Nachtrag 2026-08-24 ~14:30 — Modell-Mini-Menü (T3-Stil) live

Das Modell-Menü im Manual-Modus ist jetzt das zweispaltige Mini-Menü
wie im T3-Original: Anbieter-Leiste links (Icons Claude/OpenAI/Grok,
Buchstaben-Badges für Z.ai/Kimi/MiniMax), rechts die Modelle des
aktiven Anbieters aus dem Gateway-Katalog + "Custom model id…".
Live verifiziert (Rail-Wechsel MiniMax→Claude zeigt die jeweiligen
Modelle). Hinweis: Accounts, die nur Wildcards führen (claude-\*),
zeigen das Muster — ehrlich, bis Modell-Discovery die konkreten IDs
liefert. Chat-Suite 35 Dateien/382 Tests grün.

## Business-OS 14–17 UMGESETZT 2026-08-24 ~15:55 (Agent + Integration)

Ursache von 14: CtoxGuestManager hielt EINEN Guest und ZERSTÖRTE ihn
bei jedem Wechsel. Jetzt: Guest-POOL (Map je Instanz, LRU-Deckel 4,
Eviction über den bestehenden Teardown-Pfad; Entfernen/Abmelden/
Moduswechsel zerstören weiterhin vollständig — ein entfernter
Instanz-Guest kann nicht warm überleben). Wechsel auf einen warmen
Guest = detach/attach ohne Reload. Theme wird in alle warmen Guests
projiziert. Bewusster Trade-off (im Code dokumentiert): warmer
Reattach überspringt die Cold-Start-Revalidierung; Widerruf reißt
weiterhin über Discovery/Removal ab.
15: Neuer IPC-Kanal desktop:ctox-guest-state ({instanceId, state:
none|loading|warm}, nie Guest-Inhalte) → Sidebar-Punkt grün=warm,
amber pulsierend=lädt.
16: Chevron je Instanz-Karte (aria-expanded), Name wählt UND klappt
auf, Auswahl erzwingt aufgeklappt.
17: Eigene BOS-Fußleiste (Settings-Navigation + Katalog-Refresh);
tote Code-Einträge (Usage/Machines/PRs) dort ausgeblendet.
LIVE-BEWEIS: Thesen AG laden → Punkt warm; Welsch laden → 2× warm;
Rückwechsel auf Thesen: KEIN Lade-UI, beide warm. Suiten: Desktop 831,
Web-ctox 35, Contracts 510 (davon 6 Fixture-Fixes für modelPrompts +
xai-als-OAuth — meine Nachzügler, jetzt grün).

## 18. Provider-Icons aus der Swift-App übernommen — UMGESETZT 2026-08-24 ~15:38

Meldung: "irgendwie fehlen die korrekten icons, die waren doch schon in der
swift app drin, nimm sie doch daraus."
Quelle: claude-workjet/app/Sources/WorkjetApp/Resources/Providers/\*.svg
(kimi, minimax, zai, xai, antigravity; anthropic/openai hatte die Web-App
schon als eigene Marken). Portierung: monochrome Füllungen (#eee/#fff) →
currentColor für Hell/Dunkel; Marken-Gradienten behalten, IDs eindeutig
präfixiert; das alte PNG-basierte AntigravityIcon durch den Swift-Vektor
ersetzt. Eingesetzt in (1) der Provider-Schiene des Mini-Modellmenüs im
Composer — die Buchstaben-Badges Z/K/M sind weg — und (2) den
Provider-Zeilen der Models-Settings-Seite.
LIVE-BEWEIS: Models-Seite listet alle 7 Provider mit Icon (DOM-Probe);
Mini-Menü-Schiene Claude/OpenAI/Z.ai/xAI/Kimi/MiniMax alle mit echter
Marke (Screenshot). Suiten: web settings+composer 214 grün, Typecheck 0.
Lehre (CDP): attach.mjs wählte das ERSTE Page-Target — im BOS-Modus ist
das ein Kunden-Guest, nicht der Host; Probe-Klicks landeten in der
Thesen-Instanz. attach.mjs pinnt jetzt default auf t3code://app.

## Grok-Kette KOMPLETT 2026-08-24 ~21:43

Der Operator hat den Browser-Login durchgeführt (xAI-Account
metricspace.ai@gmail.com, In rotation, 14 models — vom UI-Review live
gesehen). Daraufhin Route „xAI (Grok)" per UI vom Platzhalter
xai-grok-pending auf den echten Account umgehängt (Editor → Account →
Save). Verifiziert: „xai-grok-pending" aus dem DOM verschwunden,
„grok-\* Served by xAI (Grok)" aktiv. Damit sind ALLE sechs Schritte der
Grok-Subscription-Kette erledigt. Offen bleibt nur noch: GPU-Pairing
(gpu3/gpu1, Operator).

## §11 Review-Runde 2026-08-24 abends — Befunde Fable (interaktiv, CDP)

Vollständiger Klick-Durchgang der laufenden App. Positiv bestätigt:
Icons Models↔Composer identisch (SVG-Fingerprints), Manual exakt 2
Reihen / Worker 1 Reihe, kein Overflow bei 1512px, alle Settings-Seiten

- Editoren funktionsfähig, Icon-Strip korrekt, BOS-Chevrons/Punkte/
  Fußleiste ok, Endzustand wiederhergestellt.

Befunde (Fixes ausstehend, Nummerierung F1…):

- F1 HOCH: Moduswechsel Worker→Manual übernimmt das Worker-Modell in
  den Manual-Zustand (claude-fable-5 → gpt-5.6-sol) und die
  Worker-Auswahl geht bei Navigation verloren (fällt auf Manual zurück).
- F2 HOCH: Zwei ewige Ladezeilen im Draft-Bereich („Checking for
  pending approvals…", „Checking both modes for cross-mode activity…"),
  > 30 min präsent, nie auflösend.
- F3 MITTEL: erledigt durch Routen-Umhängung (siehe oben).
- F4 MITTEL: Toter Menüeintrag „Cursor Agent" im Harness-Menü (Klick
  ohne Wirkung; Harness disabled/executable-not-found).
- F5 MITTEL: Effort-Chip verschwindet ersatzlos bei Modellen ohne
  Effort-Metadaten (gpt-5.6-sol) statt Default/disabled-Zustand.
- F6 MITTEL: Widersprüchliche Modellzahlen (Pool „16 models" vs
  „1 model recorded" vs Mini-Menü nur Wildcards; „Current: … not in
  the gateway catalog" neben „gpt-\* Served by Codex").
- F7 MITTEL: Refresh-Knöpfe ohne sichtbares Feedback (Models-Refresh,
  BOS-Refresh, Check for updates) — Feedback fehlt, Handler unklar.
- F8: „+ Add worker/computer…" springt zur Seite, öffnet aber den
  Anlege-Editor nicht.
- F9: xAI-Zeile hat als einziger Provider „Add account" UND „Add
  another".
- F10: Erklärtext „Codex, Claude, and Grok are intentionally excluded"
  kollidiert sprachlich mit gleichnamigen Routen darunter.
- F11: Roh-Slug „executable-not-found" statt Prosa (Computers/cursor).
- F12: Pi-Code-Zeile bricht das Zeilenmuster der Harness-Liste.
- F13: Pool-Hilfetext „…can serve nothing until listed" steht dauerhaft
  trotz gelisteter Modelle.
- F14: Escape schließt Settings samt offenem Inline-Formular (Verlust).
- F15: Prompt-Tab zeigt doppelte „Progress board"-Sektionen (Spiegel
  der Quelle, ungefiltert).
- F16: Reasoning-Optionssätze Worker-Editor vs Composer inkonsistent
  (Automatic/Ultra fehlen bzw. andere Schreibung).
- Verdachtsfälle: gpu1 alle Harnesses „not offered" (Datenimport),
  Mini-Menü-Rail folgt nicht dem aktuellen Provider, ⌘N/⇧⌘O doppelt
  als „Chat: New", Diagnostics „Resource monitor NATIVE UNAVAILABLE".
  Kimi-K3-Gegenreview läuft (Workjet-Run local-…193547Z-977e1443).

## §12 Kimi-K3-Gegenreview 2026-08-24 (2 Läufe, read-only, integriert)

Lauf 1 (voll) starb leer am 200k-Kontext → abandoned; Aufteilung in zwei
Scope-Läufe (Learning bestätigt). Beide Berichte liegen als
kimi-report-A.md / kimi-report-B.md im Session-Scratchpad; Runs als
integrated markiert. Kimi meldete ausschließlich NEUE Befunde (F1–F16
nicht wiederholt). Nummerierung K-A* (Settings+Chat) / K-B* (CTOX+Sidebar):

HOCH

- K-A1: Computers-Seite löscht Computer mit EINEM Klick ohne
  ConfirmingDeleteButton (WorkjetComputersSettings.tsx:173-189) — die
  anderen drei Flächen (Worker/Route/Account) haben ihn; Löschung
  hinterlässt Worker mit „Missing computer" ohne Warnung.
- K-A2: Unter dem Compact-Breakpoint fällt der Manual-Composer auf den
  ALTEN ProviderModelPicker zurück (ChatComposer.tsx:3381) und das
  Kompakt-Menü hat weder Harness- noch Modell-Mini-Menü — die neue
  Leiste existiert nur im breiten Layout.

MITTEL (Auswahl)

- K-A3: „Computers" benennt drei verschiedene Dinge (Top-Level-Seite,
  Environment-Picker auf Models/Harnesses, Connections-Zeiger).
- K-A4: Modus „default" heißt breit „Build", kompakt „Chat".
- K-A5/K-B6: Dieselbe Capability heißt „Web Research" (Worker-Editor),
  „Web Search" (Tools-Menü), „Extras" (Doku).
- K-A6: Worker-Editor nennt dieselbe Wahl „Provider"/„Access"/„LLM route".
- K-A7: „Set up access" navigiert weg und verwirft den ungespeicherten
  Worker-Entwurf lautlos.
- K-A8: Veraltete Ortsangaben („…managed in Connections", „Workjet
  settings") nach dem Seitenumzug.
- K-B1: Produkt-Modus-Schalter (Code|Business OS) verschwindet unter
  768px komplett — kein alternativer Wechselweg (index.css sidebar-brand).
- K-B2/K-B3: BOS-Sidebar „Remove" und ctox.dev „Sign out" ohne
  Bestätigung (destruktiv, ein Klick).
- K-B4/K-B5: Rohe Enums im UI: connection-Status („connecting"/„error")
  in der BOS-Topbar; presentationKind („t3-connect") als Untertitel.
- K-B7: Pi heißt „Pi Code" (Harnesses, π-Icon) und „Pi Agent"
  (Add-Dialog, anderes Icon); Coming-Soon-Karte obsolet.
- K-B8: Zwei xAI-Marken je Fläche (GrokIcon-Wirbel auf Harness-Flächen,
  XaiIcon-X auf Gateway/Composer).

NIEDRIG (Auswahl): K-A9 codex „Codex" vs „Codex (OpenAI)"; K-A10
„Held back (by priority)" doppelt benannt; K-A11 Roh-Slugs in Listen
(claude-code/xhigh); K-A12 Seite „Worker/Workjet/Workers" dreifach +
Doppel-Treffer in der Suche; K-A13 Model-rules-Editor doppelt bei
gleichem Modell zweier Worker; K-A14 Routen-Speichern ohne Toast;
K-A15 tote onAddComputer-Prop im Kompakt-Menü + Tab-Hash-Divergenz;
K-B9 Sidebar- vs Topbar-Instanzname; K-B10 doppelter Refresh in BOS;
K-B11 Update-Pills im BOS-Modus unsichtbar (Entscheidung Operator!);
K-B13 toter Zweig resolveAppModelSelectionState (keptSelectedProvider
=false); K-B14 „Github Copilot"-Tippfehler; K-B15 „Expiry in Unix
milliseconds"-Rohfeld im Pairing; K-B16 Pi-Statuspunkt grau=grau;
K-B17 „Not paired"-Texte divergent.

Hypothesen (Laufzeitprüfung nötig): K-AH1 Worker-Wechsel nullt
draftManagedInstructions (System-Prompt-Verlust); K-AH3 Environment-Wahl
überschreibt Computer-Custom-Label; K-AH5 Zahlen-Inputs nicht leerbar;
K-BH1 „Connecting to guest…" ohne Spinner/Timeout; K-BH3
Remove-Feedback am Listenende (unter dem Fold).

## Fix-Runde 1 zur Review-Welle — 2026-08-24 ~22:18

- F2 GEFIXT: Der Notification-Store hatte eine settle()-API („Behörde
  antwortete mit Nichts"), die NIE aufgerufen wurde — die einzigen
  Produzenten sind lokale RPC-Call-Sites, es gibt keine Remote-Antwort,
  auf die man warten könnte. CrossModeNotificationCenter settlet jetzt
  beim Mount; aus den ewigen „Checking…"-Zeilen werden die ehrlichen
  Leerzustände. (crossMode/CrossModeNotifications.tsx)
- K-A1 GEFIXT: Computers-Löschknopf nutzt jetzt ConfirmingDeleteButton
  (rot „Delete?", 4s-Auto-Entschärfung) wie die anderen drei Flächen.
- K-A9 GEFIXT: codex heißt überall „Codex (OpenAI)".
- K-A10 GEFIXT: Pool-Label vereinheitlicht „Held back by priority".
- K-B14 GEFIXT: „GitHub Copilot"-Schreibweise.
  Suiten: crossMode+settings 66 grün, Typecheck 0 Fehler.

## KORREKTUR zum „Gateway-Crash" der Mobile-Session — kein Code-Bug

Gemeinsame Diagnose mit der Mobile-Session (Messreihe dort, Isolation
hier): JEDER frische `bin.ts serve`-Prozess auf dieser Maschine wird
seit ~21:44 wenige Sekunden nach „Listening" von AUSSEN per SIGKILL
auf die Prozessgruppe beendet — unabhängig von Gateway-Config (auch
ohne), Port, Sandbox, Node-Version; triviale Node-Prozesse überleben.
Der Gateway-Code ist abgesichert (Spawn-Fehler → getypter
host-unavailable; live nachgemessen: WARN + Weiterlauf). Tatverdacht
(Zeitkorrelation, nicht bewiesen): fremde ChatGPT-Agenten-Session mit
working-dir ~/Documents/ctox (läuft seit ~21:21, Playwright-Daemon
„ctox-prod-security"); Alternative ctox-real-Dienst passt zeitlich
nicht (läuft seit 5 Tagen, frühe Läufe überlebten). OPERATOR:
Entscheidung nötig — fremde Session prüfen/stoppen. Wir fassen sie
nicht an.

## F1 GEFIXT + LIVE BEWIESEN — 2026-08-25 ~00:50

Ursache: Die Worker-Wahl lebte nur in flüchtigem Komponenten-State,
während das Worker-MODELL sticky in die geteilte Modellauswahl
geschrieben wurde — nach Unmount blieb „Manual mit Worker-Modell"
zurück. Fix: workjetWorkerId + workjetManualReturn (Manual-Modell-
Schnappschuss beim Eintritt in den Worker-Modus) sind jetzt Teil des
persistierten Composer-Drafts (composerDraftStore v1-Schema, optionale
Felder — alte Drafts decodieren unverändert); der Draft-Store ist der
einzige Besitzer der Worker-Wahl.
LIVE-BEWEIS (laufende App): (1) Manual claude-fable-5 → Sol →
zurück Manual → Modell wieder claude-fable-5 (vorher: gpt-5.6-sol-
Leck). (2) Sol gewählt → Settings → zurück → Leiste steht weiter auf
Sol (vorher: Rückfall auf Manual). F2 ebenfalls live bestätigt: keine
„Checking…"-Zeilen mehr, ehrliche Leerzustände. Suiten: chat+store 461,
Typecheck 0.

## K-A2 GEFIXT — 2026-08-25 ~00:55

Unter dem Compact-Breakpoint (1) erscheint der alte ProviderModelPicker
nicht mehr, sobald die Workjet-Manual-Leiste verfügbar ist (Gate galt
vorher nur breit), und (2) das Kompakt-Overflow-Menü bietet jetzt
Harness- und Modell-Gruppen (Modelle nach Provider gruppiert, gleiche
Gruppierungslogik wie das breite Mini-Menü, extrahiert als
groupGatewayModelsByProvider). Im Worker-Modus bleiben beide Gruppen
aus — der Worker bündelt Harness+Modell. 2 neue Komponententests
(Manual zeigt Harness/Model, Worker versteckt sie); chat-Suite 384 grün.

## Modell-Mini-Menü repariert — 2026-08-25 ~01:15 (Operator-Meldung)

Meldung: „man kann keine Modelle auswählen, das Mini-Menü ist kaputt —
rechts erwarte ich die Modelle der Anbieter, stattdessen erscheint
manchmal unten nur Text."
Zwei Ursachen: (1) Layout — die Popup-Kinder rendern im inneren
Popover-VIEWPORT (Block + Padding), meine Flex-Klassen lagen auf dem
Popup; zudem wickelt der Viewport die Kinder in einen Transitions-
Container. Fix: eigener flex-row-Wrapper im Inhalt. (2) Daten — das
Menü zeigte nur die Katalog-Wildcards (grok-_, claude-_), weil der
Catalog die ROUTEN-Muster der Accounts listet. Fix: workjetGatewayModels
(dieselbe Discovery-Quelle wie die Pools-Seite) liefert die konkreten
Modelle; Wildcards bleiben nur als Fallback für Anbieter ohne Discovery.
LIVE-BEWEIS: alle 6 Provider mit echten Listen (Claude 17, Codex 13,
Z.ai 5, MiniMax 9, xAI 15, Kimi 10 Modelle; Anzeigename + ID), Rail und
Liste nebeneinander (Screenshot model-menu-fixed.png im Scratchpad).
Draft-Zustand nach Prüfung wiederhergestellt (Codex CLI · claude-fable-5).

## Neues CTOX-Logo — FREIGEGEBEN + EINGEBAUT 2026-08-25 ~07:50

Operator-Auftrag: neues Logo („das bisherige sieht echt nicht gut aus",
„CTO in the Box", 1:1-Format, „mächtige Turbinenschaufel"). Nach vier
verworfenen Richtungen (Symbol-Kacheln, Wortmarke, Negativraum,
4-Blatt-Cartoon) freigegeben: die neu konstruierte Turbine — vier
mathematisch berechnete wide-chord-Sichelschaufeln (X-Lesbarkeit),
Stahl-Verläufe, präziser Mantelring, Spinner mit Teal-Drallmarke;
Workjet-Familienerbe bleibt erkennbar. Master: assets/ctox/ctox-logo.svg.
Abgeleitet + ersetzt: ctox-app-icon.png (650², Dock-Icon, greift beim
nächsten App-Start), ctox-app-icon.icns (voller iconset), Favicons
16/32/ico, Apple-Touch 180, ctox-windows.ico. Alte Fassungen unter
assets/ctox/legacy-2026-08-17/. Sign-in-Landingpage des Gateway-Hosts
zeigt das Logo inline (loopback.rs; Host-Binary gebaut, signiert und
nach ~/.t3/userdata/provider-gateway-host kopiert — laufender Host
unberührt, greift beim nächsten Gateway-Start). Mobile-Session wird
informiert, ihre iOS/Android-Ableitungen vom neuen Master neu zu
erzeugen.

## Fix-Runde 2 — 2026-08-25 ~08:20

- K-B2/K-B3 GEFIXT: BOS-Sidebar „Remove" (Instanz) und „Sign out"
  (ctox.dev) sind jetzt zweistufig (erster Klick schärft rot
  „Remove?"/„Sign out?", 4s-Auto-Entschärfung); aria-Namen bleiben
  instanzspezifisch.
- K-B4 GEFIXT: BOS-Topbar zeigt „Connecting…/Connected/Connection
  error/Access revoked" statt roher Enums.
- K-B5 GEFIXT: presentationKind mit Klartext-Labels („This computer",
  „T3 Connect", „SSH", „Tailscale") in Composer-Dropdown und
  Computers-Seite (gemeinsames Mapping workjetComputerKindLabel).
- K-A8 GEFIXT: veraltete Ortsangaben ersetzt („…managed in Settings →
  Computers", „Pair new remote environments in the section below",
  „No computers — add one in Settings → Computers" beide Stellen).
- Nachzügler: Pools-Test auf „Held back by priority" angepasst (K-A10).
  Suiten: ctox 35, settings+chat+ctox 618 grün, Typecheck 0. Deployt.

## Fix-Runden 3–5 („mach alles") — 2026-08-25 vormittags, KOMPLETT

Alle verbleibenden Review-Befunde umgesetzt, Commits 58c668e17 (Begriffe),
2864dfd5a (Verluste/Feedback), f582e3ba3 (Marken/tote Controls),
2730199f3 (Hypothesen) + Schluss-Slice. Deployt; Web-Komponenten-Suite
komplett gruen (1506 Tests).

Begriffe: LLM route einheitlich im Worker-Editor (K-A6); Web Search
(K-A5); Build in beiden Layouts (K-A4); Seite heisst Worker, Suche
liefert EINEN Treffer (K-A12); Environment-Picker heisst Environments
(K-A3).
Verluste/Feedback: Worker-Entwurf uebersteht "Add LLM route…" via
SessionStorage-Stash + Auto-Reopen (K-A7); "+ Add worker/computer…"
oeffnet den Anlege-Editor (F8); Escape schont offene Inline-Editoren
(F14, data-settings-inline-editor-Marker); Route-Save-Toast (K-A14);
"You're up to date"-Toast beim manuellen Update-Check (F7);
BOS-Refresh einmalig mit Mindest-Spinndauer (F7+K-B10);
Workjet-Tab-Hash via Router-replace (K-A15b — erste Fassung mit rohem
replaceState ersetzte im Hash-Router die ROUTE; live nachgemessen und
korrigiert); tote onAddComputer-Prop entfernt (K-A15a).
Marken/Controls: Pi-Agent-Karte raus (K-B7), Pi-Punkt rot bei Fehler
(K-B16), Pi-Zeile in Karten-Silhouette (F12); Cursor nicht mehr
scheinbar waehlbar (F4); Anzeigelabels statt Slugs ueberall (K-A11,
F11); "model patterns recorded" (F6); xAI-Buttons benannt (F9);
Routen-Erklaertext entschaerft (F10); Pool-Hilfetext nur bei leerer
Liste (F13); Not-paired-Tooltip im Kompaktmenue (K-B17);
Effort-Platzhalter-Chip (F5); Model-rules-Editor einmal pro Modell
(K-A13); Mode-Umschalter bleibt unter 768px (K-B1); Topbar =
Sidebar-Identitaet via geteilter Namens-Map (K-B9).
Hypothesen: Manual-System-Prompt wird beim Worker-Ausflug geparkt
(K-AH1); Custom-Computer-Label uebersteht Environment-Wahl (K-AH3);
Zahlenfelder leerbar, Commit on blur (K-AH5); "Missing computer"
statt Placeholder (K-AH4); Guest-Connect mit Spinner + 30s-Hinweis
(K-BH1); kein "ready"-Dauerstatus hinter der nativen View (K-BH2);
openApp-Fehler als Toast (K-BH4); Sidebar-Feedback oben (K-BH3).
Entscheidungen umgesetzt: Update-Pills in der BOS-Fussleiste (K-B11).
K-B8 xAI-Marken: BEWUSST zwei Marken — Grok-Wirbel = das
Harness-PRODUKT (grok-cli), X-Logo = der PROVIDER xAI; dokumentiert
statt vereinheitlicht.
OFFEN (einziger Rest): F15 — leere "Progress Board"-Sektion im
gespeicherten managedSystemPrompt; Datenbereinigung braucht einen
Settings-Schreibweg fuer Ueberschriften oder einen sicheren
Server-Neustart (Killer-Lage) — beim naechsten Neustart erledigen.
LIVE-SMOKE: Worker-Seite h1+Tabs ok, Pi Code gelistet, BOS mit genau
EINEM Refresh + Fussleiste; App im Business-OS-Modus hinterlassen.

## F15 ERLEDIGT + „Server-Killer" AUFGEKLÄRT — 2026-08-25 ~11:10

Killer-Aufklärung: Cron-Canary (außerhalb jedes Agenten-Prozessbaums)
lief unbegrenzt, identische Server aus dem Claude-Baum starben in
~1,3s → der „Killer" ist die Orphan-Hygiene des Claude-Code-Harness,
kein Fremdprozess. Produktions-App war nie gefährdet; Neustarts sicher.
Konsequenz für Agenten: Test-Server via cron/launchd oder stdin-offen
starten. eslogger-Runde damit obsolet.
F15: App sauber beendet, settings.json-Backup angelegt, leere
„## Progress board"-Überschrift aus managedSystemPrompt entfernt, App
neu gestartet (bringt zugleich das neue Turbofan-Dock-Icon). LIVE
verifiziert: Prompt-Tab zeigt genau EINE Progress-board-Sektion. App
im Business-OS-Modus hinterlassen. DAMIT SIND ALLE BEFUNDE DER
REVIEW-WELLE GESCHLOSSEN.
Übergabe-Dokument für Folge-Agenten: docs/uebergabe-desktop-agent.md

## Diagnostics Resource Monitor wiederhergestellt — 2026-08-25 ~11:25

Ursache bestätigt: Der Release-Artefakt-Builder hatte bereits einen
Cross-Target-Stager für `native/resource-monitor`, der manuelle Live-Workflow
baute aber nur Web, Server und `apps/desktop/dist-electron/main.cjs`. Direkte
Desktop-`vp pack`-Builds erzeugten deshalb weder das Rust-Target-Binary noch
`apps/desktop/prod-resources/resource-monitor/t3-resource-monitor`; der
unverpackte Alpha-Launcher konnte keinen Sidecar-Pfad an den Server übergeben.
„NATIVE UNAVAILABLE" und „Sidecar Unavailable · Restarts 5" waren zwei
Health-Zeilen desselben fehlenden Monitors.

Fix: `apps/desktop/vite.config.ts` führt nach einem erfolgreichen Pack den
neuen, getesteten Stager `scripts/stage-resource-monitor.mjs` aus. Er baut den
Host-Monitor mit Cargo locked/release, prüft das erwartete Build-Ergebnis,
staged nur das plattformspezifische Executable nach `prod-resources` und setzt
auf Unix das Executable-Bit. Das generierte Staging-Verzeichnis ist ignoriert;
der bestehende Release-Artefaktpfad bleibt unverändert und überschreibt seinen
Staging-Baum weiterhin mit dem passenden Cross-Target-Binary.

BEWEISE: fokussierte Vitest-Suite 24/24 grün
(`stage-resource-monitor.test.mjs` + `DesktopBackendConfiguration.test.ts`),
Desktop-Typecheck exit 0, gezieltes Lint/Format grün. Ein echter direkter
`pnpm exec vp pack` baute ein ausführbares arm64-Mach-O (545840 Bytes) und der
direkte NDJSON-Handshake meldete Protokoll 2, Sidecar 0.1.0, macOS/aarch64.

LIVE nach begründetem Neustart außerhalb der Agenten-Kindprozess-Hygiene via
macOS LaunchServices: Diagnostics zeigt `NATIVE HEALTHY`, Sidecar
`0.1.0 · PID 74235`, `Restarts 0`, keinen Retry-Zustand und echte Live-Werte;
Screenshot visuell geprüft. Interaktiver Smoke: vorhandener Draft
`b15d17e7-...` öffnet mit sichtbarem Composer; nach Wechsel zu Business OS
repopulieren CTOX Website Demo, GPU1 A6000, GPU3 A4500 und Meridian Supply Co.
Der bestehende Draft/Modellzustand wurde nicht verändert, Endzustand ist wieder
Business OS.

## Gateway-Modellzahlen erklärt — 2026-08-25 ~12:10

Pools und Provider Accounts verwenden jetzt dieselbe Hilfe für ihre
Modellzahlen. Die sichtbaren Kennzahlen heißen eindeutig `catalog model(s)`
beziehungsweise `account pattern(s)`: Katalogmodelle sind vom Gateway
gelistete Modelle, Account-Muster sind gespeicherte Routingmuster eines
Accounts. Der gemeinsame Tooltip stellt klar, dass beide Summen verschiedene
Dinge messen, nicht übereinstimmen müssen und weder Live-Verfügbarkeit noch
Kapazität ausdrücken. Die Änderung bleibt vollständig in der Web-Darstellung;
Contracts, Gateway und Datenmodell sind unverändert.

BEWEISE: fokussierte Komponentensuite 37/37 grün (Accounts, Pools und
gemeinsame Hilfe einschließlich Singular/Plural), Web-Typecheck exit 0,
gezieltes Format grün, Produktions-Web-Build grün. Der gezielte Lintlauf war
erfolgreich und meldete nur drei bereits vorhandene Unused-Warnungen in den
beiden berührten Bestandskomponenten. LIVE nach Client-Deploy und Reload
ausschließlich im `t3code://app`-Target geprüft: zwölf gemeinsam gerenderte
Hilfesteuerungen auf Pools und Accounts, sichtbare Katalog-/Musterlabels und
der vollständige gemeinsame Tooltip interaktiv nachgewiesen; Screenshot
`output/playwright/model-counts-help.png`. Danach vorhandenen Draft
`b15d17e7-...` wieder geöffnet und die App im Business-OS-Modus hinterlassen.

## Doppeltes „Chat: New“-Keybinding bereinigt — 2026-08-25 ~12:15

Der kanonische Default für `chat.new` ist jetzt ausschließlich `mod+n`
(`⌘N`/`Ctrl+N`); der redundante Default `mod+shift+o` wurde entfernt. Die
Server-Startup-Migration ist bewusst eng: Sie entfernt die exakte Altregel nur,
wenn zugleich die exakte kanonische `mod+n`-Regel persistiert ist. Eine allein
vorhandene Altregel gilt als Nutzerentscheidung und bleibt ebenso erhalten wie
eine nur ähnlich konfigurierte Regel. Dadurch verwenden Settings, Sidebar und
Command Palette dieselbe wirksame Shared-Konfiguration.

BEWEISE: Shared-, Server-Migrations- und Web-Suiten 91/91 grün; gezieltes
Format/Lint grün; Web- und Server-Typecheck exit 0 (nur bereits vorhandene
Effect-Suggestions im Server); Produktions-Web-Build sowie beide Server-Packs
grün. Die reale Operator-Datei enthielt vor dem Neustart genau das alte Paar
und wurde unter
`~/.t3/userdata/keybindings.json.before-chat-new-migration-20260825-1213`
gesichert. Nach dem begründeten LaunchServices-Neustart enthält sie genau
`mod+n` für `chat.new`.

LIVE ausschließlich im `t3code://app`-Target: vorhandener Draft
`b15d17e7-...` öffnete mit einem sichtbaren Composer; Sidebar-Tooltip und
Command Palette zeigten `⌘N`; Settings → Keybindings zeigte genau eine
`Chat: New`-Zeile mit `⌘N` und ohne `O`. Screenshot
`output/playwright/keybindings-chat-new-canonical.png`. Danach listete Business
OS wieder CTOX Website Demo, GPU1 A6000, GPU3 A4500 und Meridian Supply Co.;
Endzustand Business OS. GPU-Pairing, BOS-Warm-Reattach und die
Regressionswache blieben triggergerecht unverändert.

## Nutzer-App auf Workjet konsolidiert — 2026-08-25 ~16:40

Die sichtbare Desktop-Produktidentität ist in Quelle und Releasekonfiguration
exakt `Workjet`: Paket-/Fenster-/About-/Splash-/Settings-/Dialogtexte sowie
Installer- und Artefaktnamen enthalten weder `CTOX Desktop App` noch `Alpha`.
CTOX bleibt ausschließlich Backend-Bezeichnung. Bundle-ID, Updater-ID,
Linux-WM-/Executable-Identität und das bestehende Chromium-Datenverzeichnis
bleiben absichtlich unverändert, damit bestehende Installation, Updates,
Sessions, Settings und Browser-Storage nicht geforkt werden.

Neue Betriebssystem-Links verwenden `workjet://`, `workjet-dev://` und
`workjet-preview://`. `ctox-desktop*://` und `t3code*://` bleiben nur als
eingehende Aliasse registriert; intern wird weiterhin auf den bestehenden
`t3code://app`-Renderer-Ursprung normalisiert. Damit ist die sichtbare
Produktidentität migriert, ohne CORS oder persistierten Origin-Storage zu
brechen.

BEWEISE VOR LIVE-DEPLOY: fokussierte Desktop-/Web-/Release-Suite 128/128 grün,
Desktop- und Web-Typecheck exit 0 (Desktop nur vorhandene Effect-Suggestions),
gezieltes Format und `git diff --check` grün. Die reale UI-/Paket-Abnahme folgt
nach dem zusammenhängenden QR-/Rechner-Slice ausschließlich im
`t3code://app`-Target; bis dahin ist dies bewusst kein Live-Abschlussbeleg.
