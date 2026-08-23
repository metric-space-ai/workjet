# CTOX Desktop — Kanban & Recovery-Dokument

**Kopfzeile:** Die App programmiert nachweislich (OpenCode, 2026-08-23 20:51).
Blockiert sind nur zwei Anbieter aus externen Gründen. Offen ist die
Composer-Leiste und der Rest der Swift-Parität.

Stand 2026-08-23. Nur VERIFIZIERTE Fakten. Worker-Berichte sind Behauptungen;
hier steht, was ich selbst geprüft habe.

---

## DONE

### D1 · Ende-zu-Ende-Beweis: die App programmiert

Gemessen 2026-08-23 20:51, Thread `69af41d9`, DB `projection_thread_messages`:

```
user      :: Antworte ausschliesslich mit dem Wort BEREIT.
assistant :: BEREIT
state=completed · 4549 ms
```

Weg: OpenCode → **MiMo V2.5 Free**. Das ist der einzige heute belegte
funktionierende Coding-Pfad. 4,5 s = echter Modellaufruf (Fehlschläge liegen
bei 60–1400 ms).

### D2 · Anmeldefehler werden als Fehler verbucht — `ec4718f49`

Das Claude-CLI meldet API-Ausfälle in der Erfolgs-Form: `subtype: "success"`
mit `is_error: true`. Beide Klassifizierer in `ClaudeAdapter.ts` (:393, :1319)
lasen nur `subtype`. Folge: `state: "completed"`, kein Fehlerereignis, die
Fehlermeldung als Chat-Antwort. **Das ist der Grund, warum 6050 grüne Tests und
eine unbenutzbare App koexistieren konnten.** Mutationsgeprüft; live bestätigt
(`state=error` + rotes Banner).

### D3 · Smoke-Test mit Zähnen — `6f99046b6`

Vorher: 58 Zeilen, startet Electron, wartet 8 s, sucht 6 Absturz-Strings,
druckt sonst „passed". Eine App mit weißem Fenster bestand ihn.
Jetzt fünf Prüfungen, die scheitern können (Fenster, Rendering, Backend,
Composer, Skriptfehler) plus `smoke-test:turn` mit echtem Turn.

```bash
pnpm --filter @t3tools/desktop smoke-test:turn
```

### D4 · Harnesses ≠ Anmeldung — `c85100ac2`

Jede Harness-Zeile trug ihr Konto („Authenticated as … · ChatGPT Pro 20x").
`getProviderRuntimeSummary` baut nur aus Runtime-Fakten und **nie** aus
`provider.message` — dort steckt die Auth-Prosa. Mutationsgeprüft.

### D5 · Models-Seite lesbar — `dfac8d911`

Sieben `SettingsRow` à ~180 px, fünfmal derselbe Absatz, Prosa die der Knopf
daneben schon sagt. Jetzt dichte Liste, gruppiert in Connected/Available.

### D6 · Eigener Fehlalarm korrigiert — `01dcc6d3f`

Mein bernsteinfarbenes „no models discovered" las `account.modelIds` statt des
Katalogs und markierte drei gesunde Konten als kaputt. Warnung kommt jetzt aus
der Entdeckung. **Negatives Ergebnis, bleibt sichtbar.**

### D7 · Worker-Maske nach Swift-Vorlage — `087cea464`

Referenz: `claude-workjet/app/Sources/WorkjetApp/WorkerEditorView.swift`.
Reihenfolge `name → harness → provider → model → reasoning → task → skills →
target computer → ▸ technical details`, Segment-Schalter statt Aufklapplisten,
Skill-Karten mit Beschreibung, Bernstein-Hinweis bei fehlendem Zugang.
Mutationsgeprüft (Skills vor Harness schieben lässt den Test fallen).

---

## WORKING

Nichts läuft gerade. Alle Änderungen sind committet, Arbeitsbaum sauber,
0 Typfehler, 210 Settings-Tests grün.

---

## TO-DO

### T1 · Composer-Leiste — Worker · Rechner · Extras + manueller Modus

TRIGGER: sofort, hängt nicht am Import (manueller Modus = Zustand ohne Worker).
Heute: `Modell · Reasoning · Full access · Code · Orchestrator · Tools`.
Soll: `Worker · Rechner · Extras`, Erlaubnis immer voll (Wähler entfällt),
Kontext/Reasoning aus der Worker-Definition. Plus manueller Modus mit
Harness, Provider, Modell, Rechner, Extras, eigenem System-Prompt.
Dateien: `ComposerFooterControls.tsx`, `CompactComposerControlsMenu.tsx`.
FERTIG heißt: Worker wählbar, Auswahl wirkt auf den Turn, Ende-zu-Ende belegt.

### T2 · Echte Anmeldungsprüfung

TRIGGER: sofort. `probeClaudeCapabilities` erreicht die API **absichtlich nie**
(Kommentar: „This prevents any prompt from reaching the Anthropic API"), und
ein `claude auth status`-Aufruf existiert im Repo nirgends. Deshalb steht grün
„Authenticated", während jeder Turn scheitert. Weg: beobachtete Turn-Fehler
überstimmen die optimistische Sondierung.

### T3 · Workjet-Prompt-Seite

TRIGGER: nach T1. Heute **ein** rohes Textfeld (`managedSystemPrompt`).
Swift: strukturierte Abschnitte (Allgemeine Regeln, Progress Board, Worker,
Modellregeln, Worker-Aufgabe) mit je eigenem „Bearbeiten".

### T4 · Gateway-Pools konsolidieren

TRIGGER: nach T3. Dieselben fünf Anbieter stehen viermal untereinander
(Connected, Pools, Health, Models); der identische Absatz fünfmal.
Soll: eine Zeile pro Anbieter, die alles trägt.

### T5 · xAI-Anmeldung

TRIGGER: jederzeit. `native/provider-gateway/internal/auth/xai/` hat den
vollständigen Device-Flow (`discover`, `start_device_flow`, `poll_for_token`,
`refresh_tokens`). Die Management-API kennt aber nur
`anthropic-auth-url`, `codex-auth-url`, `antigravity-auth-url` — ein
`xai-auth-url` existiert nicht. Nötig sind Rust-Route, Server-Handler,
Vertrag und Oberfläche. Der Device-Flow hat eine andere Form als eine
Redirect-URL.

### T6 · Z.ai und MiniMax nutzbar machen

`GATEWAY_MODEL_CHANNELS`: `zai: null, minimax: null` — kein eingebauter
Katalog, also nur konto-eigene Modell-IDs, wofür die Oberfläche kein Feld hat.

---

## BACKLOG + OWNER

### OWNER-1 · Claude-CLI neu anmelden

Token tot: `authentication_failed`, `duration_api_ms: 0`. 13 von 13 Turns
gescheitert (Ihre elf am 18./19.08., meine zwei am 23.08.). Zugangsdaten fasse
ich nicht an.

### OWNER-2 · Legacy-Import — 14 Entscheidungen, EINMALIG

`~/Library/Application Support/Workjet/config.v1.json` (62 KB) →
`~/.t3/userdata/settings.json`. Enthält **12 Worker, 3 Computer, 7 Anbieter**.
Die Seite: _„runs exactly once — accepting or declining is recorded and never
offered again."_
Mein Vorschlag: `Local → this server`; `gpu3-a4500`/`gpu1-a6000` → **nicht
importieren** (nur „this server" wählbar; das böge Remote-Worker unumkehrbar
auf localhost); Anbieter → passendes Gateway-Konto (Kimi→Kimi, MiniMax→MiniMax,
OpenAI 1+2→Codex, Z.ai 1+2→Z.ai, xAI→nicht importieren, kein Konto).
Worker: Sol · Completion (Hard Tasks) · Cyber Security (1./2. auditor) ·
Kimi · UI/UX · Bulk · Thoroughness · Prototype A/B/C · Web Research · Terra ·
Standard Worker · Developer for synthetic data sets · Completion Worker.

### OWNER-3 · Codex-Kontingent

Anbieter-Antwort: _„You've hit your usage limit … try again at Aug 27th, 2026
1:00 PM."_ Kein Defekt der App — die Pipeline lieferte in 2 s eine echte
Anbieterantwort.

### OWNER-4 · Erlaubnis immer voll?

Angeordnet: „erlaubnis ist immer volle erlaubnis". Heißt `bypassPermissions`
für jeden Thread. Sauberer wäre, sie aus der Worker-Definition zu nehmen.

---

## 1. Environment-Fallen

- **Deploy erreicht die App nicht von allein.** `vp build` in `apps/web`, dann
  `cp -R apps/web/dist/. apps/server/dist/client/`, **dann das Fenster neu
  laden** (`location.reload()` via CDP). Ohne Reload sieht man den alten Stand
  und hält eigene Fixes für wirkungslos.
- **App mit Debug-Port starten**, sonst ist nichts prüfbar:
  `resolveElectronLaunchCommand([main.cjs, "--remote-debugging-port=9300"])`,
  `detached: true`, `child.unref()`.
- **`New thread` in der Kopfzeile legt keinen Thread an.** Der richtige Knopf
  trägt `aria-label="New thread in <projekt>"`. Sonst testet man auf einem
  gestarteten Thread — und dort ist der Anbieterwechsel **korrekt** gesperrt
  (`deriveLockedProvider` gibt bei ungestartetem Thread `null`).
- **Modellwähler-Overlay bleibt offen** und schluckt getippten Text. Erst
  Escape, dann in den Composer schreiben.
- `timeout` gibt es auf macOS nicht. `/bin/sleep` statt verkettetem `sleep`.
- `grep` ist von ugrep verschattet → `/usr/bin/grep`. zsh frisst
  `--exclude=*.map` ungequotet.
- `vp check --fix` zerschreibt Scope-Prüfungen; `vp fmt --write` nutzen.
- `Effect.ignore` fängt **keine** Defects — `Effect.catchCause`.

## 2. Fehlermuster (meine eigenen)

1. **Aus der falschen Quelle gebaut** (schwerwiegendster). Die Worker-Maske
   entstand aus dem Vertragsschema, obwohl der komplette Swift-Quellcode unter
   `~/Documents/claude-workjet/app/` liegt und die App selbst ein
   Import-Angebot auf `config.v1.json` anzeigt. Vor jedem UI-Nachbau: Original
   öffnen.
2. **Grünen Signalen geglaubt statt die App zu starten.** Tor 8 stand auf „NO
   RUNNABLE GATE" — ich notierte es und lief weiter. Erst Starten und Senden
   zeigte die Wahrheit.
3. **Warnung auf die falsche Datenquelle gestützt** (`account.modelIds` statt
   Katalog) und drei gesunde Konten als kaputt markiert.
4. **Fehler behauptet statt geprüft**: „Anbieterwechsel ist gesperrt" — war ein
   Testfehler von mir, das Verhalten ist korrekt.
5. **Plan beschrieben, dann nicht ausgeführt** (Leiste angekündigt, stattdessen
   in andere Themen abgebogen).

## 3. Evidenz-Karte

| Was                          | Wo                                                                 |
| ---------------------------- | ------------------------------------------------------------------ |
| Swift-Original (Quellcode)   | `~/Documents/claude-workjet/app/Sources/WorkjetApp/`               |
| Swift-Worker-Maske           | `.../WorkerEditorView.swift` (811 Zeilen)                          |
| Swift-Konfiguration          | `~/Library/Application Support/Workjet/config.v1.json`             |
| App-Zustand (Threads, Turns) | `~/.t3/userdata/state.sqlite`                                      |
| Turn-Protokolle je Thread    | `~/.t3/userdata/logs/provider/events.<threadId>.log`               |
| Gateway-Konfiguration        | `~/.t3/userdata/provider-gateway.json` (5 Konten)                  |
| Gateway-Host                 | `~/.t3/userdata/provider-gateway-host`, Ports 59770 / 57135        |
| Modellkanäle                 | `apps/server/src/providerGateway/ProviderGatewayManagement.ts:120` |
| Auth-Klassifizierung         | `apps/server/src/provider/Layers/ClaudeAdapter.ts:393,1319`        |
| Anmelde-Sondierung ohne API  | `.../ClaudeProvider.ts` `probeClaudeCapabilities`                  |
