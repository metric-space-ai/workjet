# Übergabe: Workjet Desktop — Entwicklungs-Handover

Stand: 2026-08-25 ~16:40 · Branch `codex/workjet-native-foundation` · Korrektur-Log in `docs/ctox-desktop-korrekturen.md` (das Log ist die Beweiskette; NICHTS dort löschen, nur anhängen).

## Woran du arbeitest

**Produktgrenze:** Die einzige Nutzer-App heißt sichtbar exakt **Workjet** und
vereint Coding und Business OS. **CTOX** ist ausschließlich das installierbare
Backend. Nicht mit `ctox/src/apps/business-os-desktop` verwechseln: Diese alte
Electron-App ist Legacy und kein Release-Ziel. Der Donor
`ctox/src/apps/business-os-mobile` ist ebenfalls keine Produkt-App.

Workjet Desktop besteht aus drei Teilen in diesem Repo:

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
  `nohup "./apps/desktop/.electron-runtime/Workjet.app/Contents/MacOS/Electron" ./apps/desktop/dist-electron/main.cjs --remote-debugging-port=9300 &`
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

- **Workjet Mobile** (paralleler Worker): arbeitet ausschließlich in `apps/mobile/**` und der Mobile-Provenienz-Doku. Er hat Branding/Links/Moduswechsel als `717b0a4a0` committed und implementiert aktuell Registry, QR-Pairing, SecureStore, Shell-Pack und native WebViews. Desktop-/Server-Dateien freihalten; Shared Contracts nur nach expliziter Übergabe ändern.
- Workjet-Worker (Kimi-Auditor etc.) für unabhängige Reviews: Brief-Muster und Fallen siehe oben; Review-Läufe read-only halten, Ergebnisse selbst verifizieren (Reports sind Behauptungen).

## Offene Aufgaben (in dieser Reihenfolge)

1. **[TRIGGER: Operator meldet GPU-Pairing]** gpu3-a4500/gpu1-a6000: Nach dem Pairing (Settings → Computers → Remote environments) die Platzhalter `unpaired-gpu3-a4500`/`unpaired-gpu1-a6000` in den Workjet-Settings durch die echten `environmentId`s ersetzen und beide Rechner real über `workjet.harness.inspect` prüfen. Die gpu1/gpu3-Asymmetrie danach belegt als Importdatenfehler, echtes fehlendes Angebot oder Laufzeitfehler klassifizieren und nur den nachgewiesenen Ursprung korrigieren.
2. **[TRIGGER: reproduzierbarer Operatorbefund] Regressionswache nach der großen Fix-Welle** (Commits `58c668e17`…`25647a77f`): Beim nächsten intensiven Operator-Gebrauch auf Meldungen achten zu: Worker-Draft-Stash und Add-Worker/Add-Computer-Rückkehr (K-A7/F8, SessionStorage), Escape-Guard (F14), Effort-Platzhalter-Chip (F5), Kompakt-Layout-Menü (K-A2). Nur reproduzierbare Befunde ändern und pro Fix einen fokussierten Verhaltenstest ergänzen.
3. **ERLEDIGT 2026-08-25 ~11:25 — Diagnostics-Degradation:** Direkte Desktop-`vp pack`-Builds bauen und stagen den nativen Resource Monitor jetzt automatisch nach `apps/desktop/prod-resources/resource-monitor/` (generiert/ignoriert; Release-Artefakte behalten ihren bestehenden Cross-Target-Stager). Fokussierte Tests 24/24, Desktop-Typecheck, Lint/Format und echter Pack grün. LIVE nach LaunchServices-Neustart: `NATIVE HEALTHY`, Sidecar `0.1.0 · PID 74235`, Restarts `0`; vorhandener Draft öffnet mit Composer, BOS-Instanzen repopulieren, Endzustand Business OS.
4. **[TRIGGER: Session-Ablauf oder Token-Widerruf gefordert/beobachtet] BOS-Warm-Reattach-Trade-off:** Warm reattach überspringt die Auth-Revalidierung (dokumentiert in `CtoxGuestManager`). Dann Auth vor Wiederverwendung revalidieren; bei Fehlschlag warmen Guest verwerfen und den normalen frischen Auth-/Attach-Pfad verwenden. Keine UI-only-Prüfung und kein stilles Weiterverwenden widerrufener Sessions.
5. **ERLEDIGT 2026-08-25 ~12:10 — Modellzahlen-Kosmetik (F6-Rest):** Pools unterscheiden jetzt „catalog models" von „account patterns"; Pools und Provider Accounts verwenden denselben Hilfe-Tooltip. Er erklärt, dass Katalogmodelle Gateway-Angebote und Account-Muster gespeicherte Routingmuster sind, die Summen nicht übereinstimmen müssen und keine Live-Verfügbarkeit oder Kapazität messen. Keine Contracts-, Gateway- oder Datenmodelländerung. Fokussierte Tests 37/37, Web-Typecheck, Format und Build grün; Lint nur mit drei bereits vorhandenen Warnungen in den berührten Dateien. LIVE im `t3code://app`-Renderer auf beiden Flächen geprüft und Endzustand wieder Business OS.
6. **ERLEDIGT 2026-08-25 ~12:15 — Keybindings-Doppel:** `chat.new` hat nur noch den kanonischen Default `mod+n`; `mod+shift+o` wurde aus den Defaults entfernt. Die Startup-Migration entfernt die Altbindung ausschließlich beim exakten alten Paar, bewusste alleinige oder abweichende Nutzerbindungen bleiben erhalten. Reale Operator-Konfiguration vorher gesichert, anschließend exakt migriert. Shared-/Server-/Web-Suiten 91/91, beide Typechecks, Lint/Format sowie Web-/Server-Builds grün. LIVE nach LaunchServices-Neustart: Settings genau eine Zeile `Chat: New · ⌘N`, Sidebar und Command Palette ebenfalls `⌘N`; Draft/Composer und BOS-Liste geprüft, Endzustand Business OS.
7. **Nice-to-have aus den Reviews, bewusst nicht gemacht:** Kompakt-Menü ohne „+ Add computer…"-Eintrag (absichtlich, Begründung im Code); xAI-Doppelmarke (absichtlich: Wirbel = Grok-CLI-Produkt, X = Provider xAI — dokumentiert, nicht ändern ohne Operator).
8. **ERLEDIGT 2026-08-25 ~16:45 — sicherer Mobile-Invite-Vertrag und Desktop-QR:** CTOX-Commit `44bbfa61a` erzeugt pro Invite einen eigenen kurzlebigen Capability-Principal und widerruft exakt diesen. Workjet-Server-Commit `8e2160b5b` stellt authentifizierte `access:write`-Endpunkte `POST /api/ctox/business-os/mobile-invites` und `/revoke` bereit. Settings → Computers erzeugt daraus ausschließlich einen kanonischen `workjet://business-os/pair?payload=…`-QR, zeigt Instanz/Ablauf und kann erneuern/widerrufen; keine manuellen Signaling-/Room-/Passwortfelder und keine Payload-Persistenz/Logs.

## Was NICHT zu tun ist

- Keine neuen Logo-Experimente — der Turbofan ist vom Operator abgenommen und überall ausgerollt.
- Keine Vereinheitlichung der xAI-Icons (siehe oben, bewusste Entscheidung).
- Keine Server-Neustarts „zur Sicherheit" — nur mit Grund, und danach Funktions-Smoke (App verbindet, Draft öffnet, BOS-Instanzen listen).
- `docs/ctox-desktop-korrekturen.md` niemals kürzen.
