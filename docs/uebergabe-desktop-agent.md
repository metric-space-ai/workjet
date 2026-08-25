# Übergabe: CTOX Desktop App — Entwicklungs-Handover

Stand: 2026-08-25 ~11:15 · Branch `codex/workjet-native-foundation` · Vorgänger-Session: Claude (Fable), Korrektur-Log in `docs/ctox-desktop-korrekturen.md` (das Log ist die Beweiskette; NICHTS dort löschen, nur anhängen).

## Woran du arbeitest

Die CTOX Desktop App = drei Teile in diesem Repo:

- `apps/desktop/` — Electron-Hülle (Guest-Pool für Business OS in `src/ctox/CtoxGuestManager.ts`, IPC in `src/ipc/`)
- `apps/web/` — das gesamte UI (Composer, Settings, BOS-Sidebar)
- `apps/server/` — lokaler Server (`dist/bin.mjs`), UI spricht per WS

Die App läuft LIVE beim Operator mit `--remote-debugging-port=9300`. Der Operator arbeitet meist im Business-OS-Modus.

## Eiserne Regeln (jede hat schon einmal Schaden angerichtet)

1. **Nichts als erledigt melden, was du nicht in der laufenden App gemessen hast.** DOM-Präsenz ≠ Verhalten. Interaktives Klick-Review mit DOM-Diff/Screenshot ist Pflicht nach UI-Umbauten. Statische Reviews hat der Operator ausdrücklich als unzureichend zurückgewiesen.
2. **Erlaubnis ist immer volle Erlaubnis** (kein Permission-Picker), **keine rohen UUIDs/Slugs/Enums im UI** (Anzeigenamen-Helfer: `workjetHarnessDisplayLabel`, `workjetReasoningDisplayLabel`, `workjetComputerKindLabel`, `humanizeHarnessProbeReason`).
3. **Architektur:** Harnesses sind Engines; Modelle/Credentials kommen vom Workjet-Gateway; das MODELL bestimmt den Account (kein separater Provider-Chip). Composer: Worker-Modus = EINE Reihe (Worker · Rechner · Tools), Manual = ZWEI Reihen (Mode · Rechner · Harness · Modell / Effort · System prompt · Rest).
4. **Ein Begriff pro Konzept.** Die Begriffs-Vereinheitlichung (LLM route, Web Search, Build, Worker, Environments) nicht wieder aufweichen.
5. **Fremde Stränge nicht anfassen:** `experiments/decision-hub-glasses/*`, `experiments/kundenpipeline-module/`, `docs/kundenpipeline-brille-plan.md` (untracked, gehören einer anderen Arbeit).
6. **Immer mit expliziten Pfaden committen** (kein `git add -A` über den Repo-Root): die Mobile-Session arbeitet in DERSELBEN Working Copy.

## Build & Deploy (exakte Prozedur)

- Web: `cd apps/web && pnpm vp build`, dann **VOM REPO-ROOT**: `cp -R apps/web/dist/. apps/server/dist/client/` (vom falschen cwd schlägt es fehl — wiederkehrende Falle).
- Server-Bundle: in `apps/server`: `vp pack` + `vp pack src/service-launcher.ts --out-dir dist --no-clean` (NICHT `vp build`).
- Desktop: `cd apps/desktop && vp pack` → `dist-electron/main.cjs`.
- Client-Deploy ist im laufenden Betrieb sicher (nur Reload nötig); Server-/Desktop-Änderungen brauchen App-Neustart:
  `nohup "./apps/desktop/.electron-runtime/CTOX Desktop App (Alpha).app/Contents/MacOS/Electron" ./apps/desktop/dist-electron/main.cjs --remote-debugging-port=9300 &`
- Pre-commit (`vp fmt`) formatiert repo-weit; Typecheck: `cd apps/web && pnpm typecheck`; Tests: `pnpm vitest run src/components` (zuletzt 1506 grün).

## Live-Verifikation (CDP-Harness)

Attach-Snippet: WebSocket auf `http://127.0.0.1:9300/json/list`, **Target mit URL-Präfix `t3code://app` wählen — NIE das erste Page-Target**: im BOS-Modus ist das ein Kunden-Guest (thesen/welsch.ctox.dev), Klicks darin treffen echte Kundeninstanzen. Vorlage steht in der Korrektur-Doku-Historie (attach.mjs: ev/click/sleep/done + shot per `Page.captureScreenshot`).

- Modi wechseln: Umschalter „Code | Business OS" oben in der Sidebar; von Settings aus erst `#/` ansteuern, dann klicken. **Nach jeder Session die App im Business-OS-Modus hinterlassen** und veränderte Draft-Chips (Modell!) wiederherstellen.
- Hash-Router: `location.hash = '#/settings/...'`. NIE einen nackten Anker (`#workjet-prompt`) setzen — das ersetzt die Route.

## Umgebungs-Fallen (gelernt, teuer)

- **„Server-Killer" (AUFGEKLÄRT):** Frisch gestartete `bin.ts serve`-Prozesse aus einem Claude-Agenten-Prozessbaum werden vom Harness ~1–3 s nach Start per SIGKILL abgeräumt (verwaiste-Kinder-Hygiene). AUSSERHALB des Agenten-Baums (cron/launchd/Electron) laufen sie unbegrenzt — per Cron-Canary bewiesen. Test-Server für Agentenzwecke daher via cron/launchd starten oder mit stdin-offener Pipe im Vordergrund halten. Die Produktions-App ist davon NICHT betroffen.
- Scratchpad (`/private/tmp/claude-…`) überlebt Session-Neustarts NICHT — alles Wichtige nach `docs/` oder committen.
- Workjet-CLI: State-Root `~/.local/state/workjet` darf KEIN Symlink sein; Brief-Dateien brauchen `chmod 600`; Start aus diesem Repo scheitert (getrackte Symlinks `CLAUDE.md`, `.claude/skills`) → Mini-Launchpad-Repo (`~/workjet-launchpad`) mit committetem Brief; Fremdmodelle unter Claude Code haben ein 200k-Fenster → große Review-Briefs in Scope-Scheiben schneiden.
- Worktree-Agenten snappen mitunter die falsche Basis — Basis-Branch im Brief erzwingen (`git reset` auf `codex/workjet-native-foundation`).
- Zwei Repo-Dateien enthalten NUL-Bytes; immer `/usr/bin/grep` statt grep-Alias.

## Koordination

- **CTOX Mobile App** (parallele Claude-Session, via SendMessage/ListAgents erreichbar): besitzt `apps/mobile/**`, `assets/ctox/ctox-{ios,android}-*.png`, additive Keys in `scripts/lib/brand-assets.ts`. Keine Contracts-Änderungen ohne Absprache — `packages/contracts` bricht sonst still die jeweils andere Seite. Branding-Master ist `assets/ctox/ctox-logo.svg` (Turbofan); Mobile leitet seine Assets daraus ab.
- Workjet-Worker (Kimi-Auditor etc.) für unabhängige Reviews: Brief-Muster und Fallen siehe oben; Review-Läufe read-only halten, Ergebnisse selbst verifizieren (Reports sind Behauptungen).

## Offene Aufgaben (in dieser Reihenfolge)

1. **[TRIGGER: Operator meldet GPU-Pairing]** gpu3-a4500/gpu1-a6000: Nach dem Pairing (Settings → Computers → Remote environments) die beiden Computer-Einträge auf die echten environmentIds umstellen (Platzhalter `unpaired-gpu3-a4500`/`unpaired-gpu1-a6000` in den Workjet-Settings) und die Harness-Deklarations-Asymmetrie gpu1 vs gpu3 prüfen (gpu1 meldet alles „not offered" — mutmaßlich Importdatenfehler, klärt sich mit echter Probe).
2. **Regressionswache nach der großen Fix-Welle** (Commits `58c668e17`…`25647a77f`): Beim nächsten intensiven Operator-Gebrauch auf Meldungen achten zu: Worker-Draft-Stash (K-A7/F8, SessionStorage), Escape-Guard (F14), Effort-Platzhalter-Chip (F5), Kompakt-Layout-Menü (K-A2). Das sind die verhaltensreichsten neuen Pfade.
3. **Diagnostics-Degradation:** „Resource monitor NATIVE UNAVAILABLE — binary not found for darwin/arm64" + „Sidecar Unavailable · Restarts 5" (Packaging, nicht UI). Ursache im Server-/Desktop-Packaging suchen; niedrige Dringlichkeit, aber sichtbar degradiert.
4. **BOS-Warm-Reattach-Trade-off:** Warm reattach überspringt die Auth-Revalidierung (dokumentiert in `CtoxGuestManager`). Wenn Sessions/Token-Widerruf Thema werden: Revalidierung beim Reattach nachrüsten.
5. **Modellzahlen-Kosmetik (F6-Rest):** Pools „16 models" vs. Accounts „1 model pattern recorded" ist jetzt korrekt beschriftet, aber die Zahlen erklären sich dem Operator weiterhin nicht von selbst — ggf. gemeinsamer Tooltip.
6. **Keybindings-Doppel:** „Chat: New" liegt auf ⌘N UND ⇧⌘O (Review-Verdacht, unbestätigt) — prüfen, ggf. einen Eintrag umbenennen/entfernen.
7. **Nice-to-have aus den Reviews, bewusst nicht gemacht:** Kompakt-Menü ohne „+ Add computer…"-Eintrag (absichtlich, Begründung im Code); xAI-Doppelmarke (absichtlich: Wirbel = Grok-CLI-Produkt, X = Provider xAI — dokumentiert, nicht ändern ohne Operator).

## Was NICHT zu tun ist

- Keine neuen Logo-Experimente — der Turbofan ist vom Operator abgenommen und überall ausgerollt.
- Keine Vereinheitlichung der xAI-Icons (siehe oben, bewusste Entscheidung).
- Keine Server-Neustarts „zur Sicherheit" — nur mit Grund, und danach Funktions-Smoke (App verbindet, Draft öffnet, BOS-Instanzen listen).
- `docs/ctox-desktop-korrekturen.md` niemals kürzen.
