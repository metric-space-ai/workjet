# Progress-Board · Decision Hub (vormals Kundenpipeline) + Brillen-Approval

## Paket F IN ARBEIT (2026-08-19 abends) — „nie wieder alte Version"
- ROOT CAUSE Upgrade-Fehlschlag: `ctox upgrade --dev` → install.sh
  --rebuild → run_rebuild → build_ctox rief `resolve_cargo` UNGE­GUARDED
  unter `set -euo pipefail`; Fleet-Guests (Prebuilt-Installs) haben KEIN
  cargo → Installer stirbt mit Exit 1 und NULL Output („release installer
  failed", Release-Dir wird weggeräumt — nichts zu debuggen).
- FIX 1 (ctox main 400d48709, GEPUSHT): build_ctox bootstrappt rustup
  selbst (ensure_rust_toolchain) und failt sonst LAUT. Im selben Commit:
  Installer-Härtung aus dem welsch-Vorfall (State-Migration, Service-Stopp
  vor Binary-Tausch, macOS-codesign).
- FIX 2 (ctox-dev deploy/fleet-timeout-fix e090a25, Vercel prod READY,
  Deployment ctox-mrx3yzypi): (a) ensureWarmPoolRelease() — pollFleet
  prüft je Zyklus 1 Warm-Pool-VM gegen main@GitHub-SHA, startet bei
  Veraltung detachtes `ctox upgrade --dev`, schreibt die bisher toten
  ctox_release_*-Spalten (current/updating/error); (b) Assign bevorzugt
  release-aktuelle VMs, nimmt nie eine VM mid-upgrade; (c) XDG_RUNTIME_DIR
  im configureFallbackLlmOnGuest-Guest-Kommando exportiert (systemctl
  --user griff sonst nie).
- welsch-Guest (Port 22017, NICHT 22003): rustup manuell installiert
  (cargo 1.97.1), `ctox upgrade --dev` läuft detached (setsid,
  ~/upgrade-dev3.log, CTOX_SKIP_OPTIONAL_RUNTIME_BUILDS=1); Hintergrund-
  Monitor pollt (Task blkz1gxc8). Alt-Version bis Abschluss: v57f8ab8.
- DANACH (Trigger: Build fertig): Service-Restart MIT XDG_RUNTIME_DIR
  (Room-Drop-in bleibt), Räume-Konvergenz prüfen, Shell-Boot über
  „CTOX wird gestartet…" hinaus SELBST im Browser verifizieren.

## Paket D ERLEDIGT (2026-08-19 nachmittags) — kompletter E2E-Beweis
- Deploy: Release-Binary mit decision_hub live (stop→copy→codesign→start).
- Read-Fix: Browser-Records leben im RxDB-Store, nicht in business_records →
  load_any_record (RxDB primär, business_records-Fallback) +
  store::load_rxdb_collection_records (neuer pub(super)-Helfer).
- Hook-Fix: Projektion in den Channel-Syncer-Tick (60s, läuft immer) statt
  in den konto-gegateten email-Adapter.
- E2E verifiziert (synthetische Mails, NUR example.org-Adressen):
  1) Ingest ohne Adress-Treffer → Vorgang „eingegangen" + Zuordnungs-
     Entscheidung mit „Routing-Vorschlag: E2E Beispielkunde" ✓
  2) Ingest mit exakter Adresse → „zugeordnet · E2E Beispielkunde" +
     Queue-Task „Triage: Portal-Login defekt" (pending) ✓
  3) kundenpipeline.triage.write → Vorgang triagiert + Triage-Entscheidung ✓
  4) kundenpipeline.delegate → Queue-Task „Kundenauftrag: …" im
     kunden-code_projekt-Workspace ✓
  5) kundenpipeline.mail.send → Mailserver-Outbound queued, Re:-Subject ✓
- ZWISCHENFALL (behoben, Regel fürs Board): mail.send-E2E ging an die ECHTE
  Kundenadresse (Demo-Seed!) — Eintrag noch pending aus stalwart_smtp_queue
  gelöscht, nichts zugestellt. REGEL: E2E nur mit example.*-Adressen;
  Demo-Seeds sollten auf Beispieladressen umgestellt werden (offen).
- Offen im Rahmen D: Triage-Agent-Lauf der Queue beobachten (2 Tasks pending);
  mail.send nutzt CTOX-Mailserver-Absender (decisions@<host>) — Relay über
  das persönliche SMTP-Konto ist späterer Ausbau; Zustellbarkeit extern
  entsprechend begrenzt bis dahin.

## Paket D (Detail): Code (2026-08-19 mittags)
- NEU src/core/business_os/decision_hub.rs (ctox-Repo):
  project_inbound_messages (Ingest inbound email → kundenpipeline_vorgaenge/
  _entscheidungen, Projekt-Routing, deterministische IDs = idempotent;
  Hook in service.rs nach jedem email-Sync), enqueue_triage_task (CTOX-Queue-
  Task, Agent schreibt via kundenpipeline.triage.write zurück; Mail-Body als
  Daten deklariert), Command-Handler triage.write / mail.send (CTOX-Mailserver
  queue_email, Reply-Subject, mails_json+Audit) / delegate (Queue-Task im
  code_projekt des Kunden, run_json-Referenz). Policy je Handler:
  data.write auf kundenpipeline_vorgaenge (Scoped) — Browser-Actor local-dev
  ist durch bestehende Grants gedeckt.
- command_plane.rs: Dispatch-Arm für kundenpipeline.*; mod.rs registriert.
- App-Seite: Annehmen der Mailfreigabe → dispatcht kundenpipeline.mail.send;
  Annehmen der Triage (mit Aufgabe) → kundenpipeline.delegate. Push ok,
  validate ok. cargo check fehlerfrei.
- Release-Build läuft (frisches Target runtime/build/cargo-target, dauert);
  Warte-Task bo8w3em8n meldet Binary. Danach: Deploy (stop→copy→codesign→
  start) + E2E über Command-Plane.
- FALLE: grep-Wartemuster "error:" matchte Warnungstext „pub error:" —
  auf Binary-Existenz warten, nicht auf Log-Strings.

## Installer-Fixes eingecheckt (2026-08-19 vormittags, install.sh im ctox-Repo)
- stop_running_ctox_service(): Upgrade stoppt den Dienst VOR dem Release-Umbau
  (behebt rm-Fehler, Alt-Prozess nach Binärtausch, Runtime-Race).
- migrate_previous_runtime_state(): einmalige Migration eines echten
  runtime/-Verzeichnisses des Vorgänger-Release nach STATE_ROOT (nie eine
  größere State-DB überschreiben) — behebt den „frische Instanz"-Bug.
- Race-Heilung: materialisiertes release/runtime-Dir wird in STATE_ROOT
  gefaltet und durch den kanonischen Symlink ersetzt.
- codesign_binary(): Ad-hoc-Signatur nach jedem Binary-Copy (macOS SIGKILL).
- bash -n ok. Live-Zustand konsolidiert: current/runtime → Symlink auf
  ~/.local/state/ctox, Instanz 2A75D5, Endpunkte ok.
- NEUE FALLE entdeckt: Um 02:08 hat ein nächtlicher Prozess (Update-Apply oder
  Parallel-Session) ~/.local/bin/ctox-real mit älterem Build überschrieben →
  Fix-Binary aus current/bin restauriert + signiert. Wer 02:08 schreibt, ist
  ungeklärt — beobachten.

## Paket C ERLEDIGT (2026-08-19 nachts): deployed + Ende-zu-Ende am Endpunkt verifiziert
- Neues Release v0.3.31-1906-g50ba34123-dirty aktiv; /api/business-os/mail/
  accounts lebt (Guard-Allowlist ergänzt: Konto-Config ist Control-Plane).
- Probe-Lebenszyklus verifiziert: POST (owner=local-dev, has_password:true,
  Secret im Store) → GET Liste → DELETE inkl. Secret-Cleanup.
- Mail-App-Panel „Persönliches Konto verbinden" wird ausgeliefert.
- OFFEN (Owner): echtes Postfach im Panel eintragen; erster echter Sync-Lauf.
- DEPLOY-FALLEN (alle gelöst, für die Zukunft):
  1) Reinstall bei laufendem Service → rm des Release-Dirs schlägt fehl
     („Directory not empty"). Erst ctox stop.
  2) Installer startet den Dienst VOR dem Binärtausch → alter Prozess läuft
     weiter; ctox stop erwischt ihn nicht (kill <pid> nötig).
  3) Ersetztes Binary wird von macOS per SIGKILL (exit 137) getötet —
     Signatur ungültig. Fix: codesign -s - -f ~/.local/bin/ctox-real.
  4) KRITISCH: install.sh migriert runtime/ des alten Releases NICHT
     (Instanz-Identität, business-os.sqlite3 1.8GB, Grants, Secrets) →
     frische Instanz 6BE29E erschien. Fix: Service stoppen, runtime/ per
     rsync (ohne *.sock/*.lock) vom alten Release übernehmen. Danach
     Instanz 2A75D5, Decision Hub (6 Einträge) und Projekte-Band intakt.
     → Das ist ein echter CTOX-Installer-Bug (Upgrade-Migration fehlt).

## Paket C (Detail): Externes Mail-Konto — Code (2026-08-19)
- BEFUND: CTOX hat bereits einen vollständigen nativen E-Mail-Client
  (src/core/communication/email_native.rs: IMAP/SMTP/Graph/EWS/ActiveSync,
  sync/send/test, Ingestion in communication_messages) — aber nur für EIN
  Instanz-Konto aus dem Operator-Env (CTO_EMAIL_*). Genau die Owner-
  Unterscheidung: Instanzkanal = System-Setting, persönliches Konto fehlte.
- NEU src/core/communication/email_accounts.rs: Registry persönlicher Konten
  (CTO_EMAIL_ACCOUNTS im Runtime-Env, ohne Secrets; Passwörter im Secret-
  Store Scope email-account), upsert/delete/list, Overrides-Builder der den
  bestehenden Konnektor unverändert nutzt (Instanzwerte werden explizit
  geleert, nie geerbt), communication_accounts-Upsert. Unit-Test grün.
- email_native::service_sync → Multi-Account: Instanz-Konto + alle
  persönlichen Konten je Sync-Lauf, Fehler je Konto isoliert.
- Server-Endpunkte: GET/POST /api/business-os/mail/accounts (+/delete),
  Session-Auth, Owner-Scoping (nicht-Admins nur eigene Konten), Passwort
  nur im POST-Body → Secret-Store, nie in Antworten (has_password-Flag).
- Mail-App: Panel „Persönliches Konto verbinden" in den Mail-Einstellungen
  (Adresse, IMAP/SMTP Host+Port, Passwort) + Liste verbundener Konten mit
  Trennen. cargo check 0 Fehler, node --check ok.
- DEPLOY: ./install.sh --backend=metal aus Documents/ctox läuft im
  Hintergrund (Task bm1z9it0n, Log install-run-*.log im Checkout);
  erzeugt neues Release (HEAD 50ba341+dirty, 61 Commits neuer als das
  installierte vd177311) und schwenkt current um.
- Danach ausstehend: Ende-zu-Ende-Probe (Konto verbinden → Sync → Nachricht
  in communication_messages) — die echten Zugangsdaten gibt der Owner ein.

## Paket B erledigt: Projekte/Routing (2026-08-19, in echter Shell verifiziert)
- Neue Collection kundenpipeline_projekte (name, adressen_json, domains_json,
  code_projekt, notizen, aktiv) + Grants (local-dev read/write) dispatcht.
- Viertes Band „Projekte (n)": Liste, Anlegen/Bearbeiten per Modal
  (+-Button ist band-kontextabhängig), Zeile = Name · #Adressen · Domains ·
  Code-Projekt.
- Routing-Lookup projektFuerAbsender(): exakte Adresse → Auto-Zuordnung
  (Vorgang startet als „zugeordnet", kunde_id/kunde_name gesetzt, ggf. direkt
  Triage-Entscheidung); Domain-Match → „Routing-Vorschlag: <Kunde>" in der
  Zuordnungs-Entscheidung.
- VERIFIZIERT in der Shell: Projekt „REM Capital" (j.cakmak@remcapital.de /
  remcapital.de / ~/Projekte/rem-gateway) angelegt; neuer Vorgang mit dieser
  Absenderadresse → „Zugeordnet · REM Capital" ohne manuelle Entscheidung.
- FALLE (Environment): Nach dem Nachrüsten einer neuen Collection kannte die
  Browser-DB sie nicht (Writes scheiterten still, Modal blieb offen).
  Fix: IndexedDB + localStorage der Shell-Origin leeren → frischer Voll-Sync.
  Für Endnutzer braucht das später eine saubere Client-Migration.
- validate ok:true nach allen Pushes.

## DURCHBRUCH: Paket A erledigt — App läuft in der Shell MIT Daten (2026-08-19)
- Der Grant-Dispatcher EXISTIERT bereits im installierten CTOX:
  `ctox business-os commands dispatch --input <json>` (generische Command-Plane-
  Einspeisung, TrustedLocal, claimed actor wird vertraut). Kein Rust-Umbau nötig.
- 4 Grants dispatcht: ctox.app.access.grant für user:local-dev ×
  {data.read,data.write} × {kundenpipeline_vorgaenge,_entscheidungen} →
  grant_ids app-access:kundenpipeline:user:local-dev:… , Status completed.
- Rezept für künftige Apps: Command-JSON mit payload{module_id,subject_type,
  subject_id,permission,collection} + client_context.actor = Admin-User
  (z. B. fable-agent); Actor braucht roles.manage.
- Danach: alter renderCard-Restbezug gefixt, refresh-catalog, Reload →
  Decision Hub mountet in der Shell, Seed schreibt, Offen(6) sichtbar.
- Hinweis: Erster Seed-Klick direkt nach Mount schlug leise fehl (Collections
  noch nicht bereit) — zweiter Klick ok. Robustheit später prüfen.

## Done: Feedback-Runde 3 (2026-08-19)
- UMBENANNT: App heißt jetzt „Decision Hub" (Hub für Executive-Entscheidungen);
  Titel/Kicker/Manifest/Store-Summary geändert. Technische Modul-ID bleibt
  vorerst kundenpipeline (ID-Rename = neue Collections = Grant-Thema erneut).
- Scroll-Sensitivität: Rad-Deltas werden akkumuliert (1 Schritt je 70px),
  Swipe-Schrittweite 2 Zeilen.
- Demo-Seed legt wieder 3 UNTERSCHIEDLICHE Items an (REM/Triage,
  Schulz&Partner/Zuordnung, Bäckerei Hoffmann/Ergebnisfreigabe) → Tab-
  Navigation über Items testbar.
- Desktop-Modus v2: Antwort-Vorschlag und Aufgabe (Agent + Beschreibung)
  DIREKT editierbar (change → writeVorgang, Triage-Entscheidung wird neu
  aufgebaut → Brille zeigt denselben Stand); echtes Mikrofon-Diktat
  (Web Speech API, de-DE/en-US) an beiden Feldern und am Korrektur-Komposer,
  Aufnahme pulsiert rot; Icon-Aktionen ✓ ✗ ◷ im Kopf.
- Alles gepusht, app validate ok:true, 11/11 Tests grün.

Headline: Display-Bedienmodell final (Owner-Spezifikation, von Fable direkt
umgesetzt nach Owner-Freigabe, Workjet/Kimi weiter defekt); in CTOX
eingespielt, validate ok. Letzter Blocker unverändert: Daten-Grants.

## Done: Modus-Umschalter Brille/Desktop (2026-08-19)
- View-Band „Brille | Desktop" im Arbeitsbereich (eigenes Band, guide-konform).
- Desktop-Modus: dieselbe Entscheidung als Seite — Kopf (Typ · Kunde, Titel,
  Icon-Aktionen ✓ ✗ ◷ oben rechts), Abschnitts-Karten MAIL (mit Absender),
  ANTWORT-VORSCHLAG, AUFGABE → Agent, Korrektur-Abschnitte; Komposer bleibt.
- Gepusht + validate ok:true. 10 Zeilen + Tab-Header im Glas-Modus fixiert.

## Done: Display v3 — durchgehender Scroll-Fluss (2026-08-19)
- Reiterleiste oben ERSETZT den Kopfblock: alle offenen Items als Tabs,
  aktiver hell + Unterstrich, Scrollposition n/m rechts.
- Genau 10 Textzeilen (17px Mono, ~52 Zeichen) + Tab-Header + Icon-Zeile;
  Owner hatte mehr Dichte erst gewünscht, dann auf 10 Zeilen zurückgenommen.
- EIN Fluss: Swipe scrollt den Volltext; am Textende wandert der Fokus auf
  die kompakte Icon-Zeile (✓ Annehmen, ✗ Ablehnen, ✎ Korrektur diktieren,
  ◷ Auf später); fokussiertes Icon invers + Label; über das letzte Icon
  hinaus beginnt das nächste Item. Press aktiviert, Double-Press zurück.
- Neu: Vertagen (Queue-Ende via created_at_ms), Korrektur-Icon fokussiert
  den Komposer; Desktop-Extras: Tabs und Icons im Canvas klickbar (hitTest),
  Mausrad folgt demselben Fluss; Gestenleiste nur noch 4 Hardware-Symbole.
- Cache-Buster-Falle behoben: Renderer wird dynamisch mit ?v importiert
  (statischer Import blieb über Modulversionen gecacht — Guide-Muster).
- 11/11 Tests grün; in CTOX gepusht, app validate ok:true; Flow im
  Preview verifiziert (Scroll 10/17 → ✓-Fokus invers → Item-Wechsel).

## Erkenntnisse Daten-Grants (2026-08-18 abends, alle verifiziert im Code)
- Runtime-Apps brauchen explizite Collection-Grants aus
  business_permission_grants; Rollen (auch admin) genügen NIE
  (app.js guardAllowsCollectionPermission → hasReviewedCollectionDataGrant).
- Die vorhandenen aktiven Grants für Rollen user/founder sind
  migration.sync.*-Seeds (store.rs) und werden vom Mount-Guard BEWUSST
  ignoriert. Die Settings-Tabelle zeigt sie trotzdem → irreführend.
- Gültige Grants entstehen nur durch Command ctox.app.access.grant
  (grant_id app-access:*, braucht roles.manage; Payload subject_type
  user|role, permission data.read|data.write, collection modul-eigen).
  Kein CLI, kein MCP-Tool, keine Settings-UI dispatcht ihn bisher —
  nur App-Store-Install-Flow/Command-Plane.
- Verantwortlichkeit („Verantwortliche:n zuweisen" → local-dev) gesetzt;
  löst App-Sichtbarkeit, NICHT Datenrechte.
- local-dev Rolle final: user (Session-Injection verifiziert via curl auf /).
  issue-capability ändert Rollen nur mit --ensure-user zuverlässig.
- Mein Logout hatte den localStorage-Lock ctox.businessOs.loggedOut gesetzt;
  entfernt, implizite Loopback-Session läuft wieder.
- App-Fix eingespielt: fehlende Rechte sind jetzt regulärer Zustand
  (Callout „Zugriff anfordern" via ctx.contextActions, kein Mount-Crash;
  auch Subscriptions guarded — `$`-Zugriff wirft synchron).

## Done (neu, 2026-08-18 nachmittags)
- Capability-Kette gelöst: issue-capability (Owner) → connect-info (8765) →
  MCP-Bearer (mcp.token im Scratchpad) → Actor mcp:local als Admin persistiert.
- App über prepare_app_source + write_app_file nach
  runtime/business-os/installed-modules/kundenpipeline installiert.
- Alle 7 Static-Check-Findings behoben: Renderer nach core/, Fremd-Collection
  entfernt (Ingest später via Mail-App-Übergabe), CSS tokenisiert (Grün nur im
  Canvas), Command-Bus-Automation (Korrektur → business_os.chat.task
  kundenpipeline.vorschlag_rework), primäre Anlegen-Aktion + Modal,
  core/records.mjs auf kundenpipeline_vorgaenge, Markup-Load-Muster.
- `ctox business-os app validate kundenpipeline --installed` → ok:true (8/8 Modultests).
- Shell zeigt App in Taskbar (v0.1.0 · Privat), Fenster öffnet.
- KORREKTUR/Befund: app smoke schlägt auch für System-Modul `notes` fehl
  ("business_module_catalog collection is required") → Umgebungsproblem des
  Headless-Smoke, nicht unsere App. Playwright-Chromium wurde installiert.
- Blocker live: Mount meldet "Kein Leserecht für kundenpipeline_vorgaenge"
  für Shell-User local-dev; Rolle auf admin angehoben, Sync hängt am laufenden
  CTOX-Update (CTOX_MAINTENANCE_READ_ONLY). Nach Update-Abschluss neu öffnen.

## Done
- Plan: docs/kundenpipeline-brille-plan.md (revidiert: nutzt CTOX-Module mail/conversations/customers).
- Modul v0.1 in experiments/kundenpipeline-module/ — design-guide-konform umgebaut:
  Pane-Grammar (data-pg-*, gezähltes Band Offen/Vorgänge/Erledigt, Tray, Footer),
  Kontext-Trios, Icon-Aktionen (Seed/Import/Export), Tokens statt Eigenfarben,
  zwei Panes + Resizer (rechte Spalte entfernt auf Owner-Wunsch).
- Display v2: 576×288-Canvas, 16 Grünstufen, kompakte Kopfzeile, scrollbarer
  Textkörper mit Indikator, EINE Gestenleiste (Labels dynamisch), Mail-Ballast-
  Stripping (stripMailBody), Abschnitte MAIL/ANTWORT-VORSCHLAG/AUFGABE→Agent,
  Korrektur-Komposer (Desktop-Ersatz für Brillen-Diktat).
- Tests: 8/8 grün (node --test tests/kundenpipeline.test.mjs).
- Preview verifiziert: http://localhost:8919/preview.html (REM-Capital-Demo-Vorgang).
- Worker-Probe 2026-08-18T11:31:21Z: Kimi · UI/UX ready; Sol timeout; Terra failed.

## Working
- (nichts aktiv — zwei Blocker, siehe Backlog)

## To-Do
- Display-Redesign „Fokus-Karussell" per Owner-Spezifikation (TRIGGER: Workjet-
  Repo-Runs funktionieren wieder ODER Owner erlaubt Direktumsetzung durch Fable):
  Reiterleiste aller Items oben; Swipe navigiert Inhalt→Buttons→nächstes Item;
  Fokus-Selektion invers; Press aktiviert/öffnet Lesemodus; Double-Press zurück.
  Brief liegt bereit: /Users/michaelwelsch/Documents/kpl-launchpad/BRIEF.md.
- Desktop: Routing einstellen + Projekte anlegen + Verknüpfung zu CTOX-Code-
  Projekten (Owner-Anforderung; TRIGGER: nach Display-Redesign, getrennt
  delegieren, gleiche Dateien nicht parallel bearbeiten).
- Install in CTOX als echte App via business_os.prepare_app_source/write_app_file
  + app validate/smoke (TRIGGER: Capability, siehe OWNER).
- Phase 0 laut Plan: Postfächer im mail-Modul anbinden, Kundenstamm in customers.

## Backlog + OWNER
- OWNER: Capability für App-Entwicklung ausstellen (Kommando):
  ctox business-os auth issue-capability --user fable-agent --display-name "Fable Agent" --role admin --ensure-user
- OWNER: Workjet-Blocker prüfen — jeder Repo-Run endet mit
  local_run_failed: "Eine Workjet-Datei verweist auf einen unsicheren Speicherort."
  (auch aus sauberem Launchpad ~/Documents/kpl-launchpad mit Trivial-Brief;
  Health-Probe der Worker ist ok → Fehler liegt in der Workjet-App/Worker-Datei-
  Konfiguration, in der Workjet-App öffnen und reparieren).
- OWNER: Entscheidung, ob Fable das Fokus-Karussell direkt umsetzen darf,
  solange die Kimi-Delegation blockiert ist.

## Environment traps
- workjet run aus Documents/workjet: Snapshot scheitert an Symlinks im Repo
  ("Symlinks werden für Remote-Workspaces … nicht übernommen").
- workjet run mit Brief/Launchpad unter /private/tmp: "unsicherer Speicherort"
  (aber gleicher Fehler auch aus ~/Documents → App-seitig).
- CTOX MCP über CLI: Actor ctox-cli:* hat keine Produktrechte (PermissionDenied
  für query_records/prepare_app_source); Channel-Policy ok. issue-capability vom
  Claude-Classifier blockiert → Owner-Aktion.
- Preview-Harness: Kit-`[hidden]` braucht explizites display:none (in index.css
  ergänzt); Browser-Pane ist schmal → zoom 0.45 für Screenshots.

## Evidence map
- Modul: /Users/michaelwelsch/Documents/workjet/experiments/kundenpipeline-module/
- Launchpad (sauberes Git, Baseline a0be498): /Users/michaelwelsch/Documents/kpl-launchpad/
- Kimi-Brief: kpl-launchpad/BRIEF.md
- Design-Guide/Skill (geladen via MCP): scratchpad/ctox-skill/{skill,design-guide}.md
- Preview-Server: python3 http.server 8919 im Modulordner (läuft im Hintergrund)

## Managed-Instanz welsch.ctox.dev provisioniert (2026-08-19 nachmittags)
- Admin-Account michael.welsch@metric-space.ai in der Prod-Neon-DB verifiziert
  (ctox_admin) + Passwort neu gesetzt (scrypt-Schema aus lib/auth.ts); Login
  gegen Live-ctox.dev erfolgreich → bestätigt, dass .env.local die Prod-DB ist.
  (Der ursprüngliche Passwort-Login schlug NUR am falschen Passwort, nicht an
  Rechten — Account hatte bereits has_pw=t, role=ctox_admin.)
- Tenant welsch (welsch.ctox.dev) angelegt: managed_fleet, owner=michael,
  tenant_members owner, Fleet-Warm-VM zugewiesen (ctox-0b11a7b9, DNAT
  217.182.134.181:22017), ssh_credentials + fallback_llm (MiniMax-M3) gesetzt,
  status=active. welsch.ctox.dev liefert „Welsch (Decision Hub) Business OS
  Login" (HTTP 200).
- ECHTER FLEET-BUG gefixt (Branch fix/fleet-guest-config-timeout in ctox-dev):
  configureFallbackLlmOnGuest hatte SSH timeoutMs 60s, aber der in-Guest-
  Readiness-Loop (30x2s) + ctox.service-Restart braucht auf kalten Warm-VMs
  >60s bis native_rxdb_peer_available=true → „SSH command timed out". Auf 240s
  angehoben. Assignment danach in EINEM Lauf sauber (genau 1 Instanz).
- ZWEITER FLEET-BUG (dokumentiert, NICHT gefixt): assignWarmInstanceToTenant
  leakt bei Fehlschlag Warm-VMs — jeder erneute Poll claimt eine weitere VM
  (tenant bleibt deploying, fleet_instance_id null). Beim Debuggen mehrfach
  passiert, VMs manuell zurück in warm_pool gesetzt. Braucht eigenen Fix
  (claim nur wenn tenant noch keine assigned/error-Instanz hat).
- Provisioning lief lokal via projekteigener lib (npx tsx assignWarmInstance…)
  gegen Prod-Env, weil der HTTP-Poll am Cloudflare-Edge (100s) 504t, bevor die
  SSH-Guest-Config fertig ist. Secrets/Keys/Skripte nach Abschluss gelöscht.
- OFFEN: Fleet-Fix-Branch nach ctox.dev deployen (sonst greift der 240s-Fix in
  Prod noch nicht, künftige Rentals treffen wieder den 60s-Timeout);
  Even-Realities-Brille (Hardware ausstehend).

## Fleet-Fix in Produktion + welsch-Decision-Hub-Blocker (2026-08-19 abends)
- FLEET-TIMEOUT-FIX DEPLOYED: sauberer Branch deploy/fleet-timeout-fix auf
  origin/main-Basis (nur lib/fleet.ts +5/-2), nach GitHub gepusht, Vercel
  Preview grün → `vercel deploy --prod` → Aliases ctox.dev + *.ctox.dev zeigen
  auf den neuen Build (ctox-9fr13ofvg, Ready). Fremde WIP im ctox-dev-
  Arbeitsbaum wurde NICHT mitgeschickt (isolierter git worktree genutzt).
- DECISION HUB AUF welsch.ctox.dev — BLOCKIERT (bewusst gestoppt):
  * Guest-VM (DNAT 217.182.134.181:22017) ist Linux x86_64 Ubuntu 24.04,
    fährt ALTE Warm-Pool-Image-Version CTOX v57f8ab8: KEIN decision_hub,
    KEINE mail/accounts, nur `matching`-Modul, MCP hat nur 23 Tools
    (kein prepare_app_source/write_app_file → App-Source-Install unmöglich).
  * Voller Decision Hub braucht die NEUE CTOX-Core-Version als LINUX-Build.
    Mein lokales Binary ist macOS-arm64 (läuft nicht auf Linux).
  * Meine ctox-Core-Änderungen (decision_hub.rs, email_accounts.rs, server.rs,
    command_plane.rs, mod.rs, service.rs, install.sh, mail-Modul) liegen im
    geteilten Documents/ctox-Arbeitsbaum UNTRENNBAR vermischt mit dutzenden
    uncommitteten Dateien der Parallel-Session „CTOX Desktop App" → keine
    saubere Isolation, kein verantwortbarer Prod-VM-Rebuild auf dieser Basis.
- EMPFOHLENER PFAD (Owner-Entscheidung nötig):
  1) Meine ctox-Core-Änderungen in der ctox-Session/Repo sauber committen
     (getrennt von der Parallel-Session-WIP) und in den Release-Kanal bringen.
  2) Warm-Pool-Image auf die neue Version neu bauen ODER Guest per
     `ctox upgrade --dev` auf einen Build mit decision_hub heben.
  3) Danach auf welsch: Decision-Hub-App via app-source-MCP installieren,
     Grants dispatchen (ctox.app.access.grant), Projekte anlegen,
     persönliches Mail-Konto verbinden. (Alle Schritte lokal erprobt.)
- STATUS gesamt: Managed-Instanz welsch.ctox.dev LIVE + Admin-Login ok +
  Fleet-Fix in Prod. Decision-Hub-Rollout auf welsch wartet auf Core-Release.

## KORREKTUR: welsch.ctox.dev Login war kaputt (2026-08-19 abends, behoben + echt getestet)
- FEHLER VON MIR: Ich hatte nur HTTP 200 + Seitentitel geprüft, nie den Login.
  Der Tenant-Login authentifiziert gegen tenant_business_os_users (pro Tenant
  eigene Nutzer) — meine Direkt-Provisionierung hatte den Onboarding-Schritt
  „ersten Business-OS-User anlegen" übersprungen → Tabelle leer → jeder Login
  schlug fehl. REGEL: Ein Login-Flow gilt erst als fertig, wenn der echte
  POST mit Session-Folgeseite verifiziert ist.
- FIX: User michael.welsch@metric-space.ai (role admin) für Tenant welsch
  angelegt (Produkt-Muster aus output/provision-thesen-*, hashPassword aus
  lib/auth). Passwort = ctox.dev-Passwort.
- VERIFIZIERT: POST https://welsch.ctox.dev/login → 303 → Shell mit
  "authenticated":true (Session-Cookie-Roundtrip).
- Außerdem: business_name von „Welsch (Decision Hub)" auf „Welsch" geändert
  (Owner fand den Zusatz unpassend — Login-Titel zeigt jetzt „Welsch").

## welsch.ctox.dev Pairing-Defekt behoben (2026-08-19 spät)
- SYMPTOM: Shell hing ewig bei „CTOX wird gestartet…", Settings meldete
  „CTOX Service läuft nicht" — obwohl der Guest-Service lief.
- URSACHE (Warm-Pool-Image-Bug, alte CTOX v57f8ab8): sync_room =
  instance_id + hash(room_password). Auf dem Guest lasen SERVICE und CLI
  VERSCHIEDENE Raum-Quellen → Service replizierte in Raum A
  (biz_22536cf8:JAlBwB4…), die Shell gab Browsern Raum B
  (biz_cd5831ba:… aus `ctox business-os peer status` via SSH). Browser
  paarte ins Leere → Katalog-Sync tot.
- ZUSÄTZLICH: `systemctl --user restart` aus configureFallbackLlmOnGuest
  griff nie (non-interactive SSH ohne XDG_RUNTIME_DIR) — deshalb zeigte
  Settings auch Local-Qwen statt MiniMax-Proxy. Zweiter Fleet-Bug fürs
  ctox-dev-Repo (XDG_RUNTIME_DIR im Guest-Kommando exportieren).
- FIX auf dem Guest: (1) instance-id-Datei auf die CLI-Identität
  (biz_cd5831ba) angeglichen; (2) Room-Passwort als
  CTOX_BUSINESS_OS_ROOM_PASSWORD per systemd-User-Drop-in
  (~/.config/systemd/user/ctox.service.d/room.conf, chmod 600) gepinnt —
  Env hat höchste Priorität in business_os_room_password(); (3) Restart
  MIT XDG_RUNTIME_DIR. VERIFIZIERT: Service-Log-Raum == CLI-peer-status-
  Raum == in Shell-HTML injizierter sync_room (alle drei identisch).
- OFFEN/PRODUKT: (a) Warm-Pool-Image-Fix, damit frische VMs konsistent
  starten; (b) XDG_RUNTIME_DIR-Fix in lib/fleet.ts guest-Kommandos;
  (c) Owner-UX-Wunsch: Setup lazy machen — fehlende Settings nur als
  verlinkte Liste zeigen statt blockierendem Einrichtungszwang.
