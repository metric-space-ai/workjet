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
