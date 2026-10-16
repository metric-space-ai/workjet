# Toolhub in V4 (Backlog, E49)

Stand 2026-10-16, V4-G2. Der Toolhub-Weg über die Gast-Shell ist nicht Teil
von V4: weder die V2- noch die v4-Shell kennt `workjetToolhubControl`, und das
CTOX-Befehlsinventar hat kein `ctox.toolhub.*`. Jeder Aufruf endete mit
`core_outdated`. Die Einstiegspunkte wurden deshalb entfernt.

## Entfernt (Commit 74fe76ded, PR „Toolhub-Einstiege entfernen“)

- Einstellungen › Schnittstellen (`/settings/integrations`): Seite, Navigation,
  Suchbegriffe (`IntegrationsSettings.tsx`, `useToolhubIntegrations.ts`,
  `routes/settings.integrations.tsx`).
- Chat: angeheftete Toolhub-Karten über dem Composer
  (`SessionRequestCards.tsx`, `toolhub/ToolhubCards.tsx`, Fixture).
- Kalender-Konten: „Hinzufügen“ für Outlook/Calendly über den Toolhub.
- Desktop: IPC `desktop:toolhub-request` / `desktop:toolhub-authorize`,
  Preload `toolhubRequest` / `toolhubAuthorize`, Vertragstypen in
  `packages/contracts/src/ipc.ts`, `CtoxGuestManager.requestToolhub`,
  `buildGuestToolhubExpression`, Login-Fenster für Toolhub-OAuth.
- Katalog auf den Kalender-Eintrag gekürzt (`connect: "mcp" | "token"` und
  `isToolhubConnect` entfallen), ungenutzte Logos gelöscht.
- Wächter: `apps/desktop/src/ctox/toolhubPathRemoved.test.ts`.

Bleibt: native Google-Kalender-Anmeldung (#784, ctox #875) mit
`calendar/CalendarAuthorize.ts`, `CALENDAR_AUTHORIZE_ORIGINS` und
`guestInstanceOrigin`. Unberührt: Server-MCP-Operationen `toolhub_*` im
Business-OS-Werkzeug und das `ctox-toolhub`-Skill (Agentenweg, nicht UI).

## Was V4 bräuchte

1. CTOX-Plattformrouten `ctox.toolhub.{connections,catalog,tools,connect,
   disconnect,credential.submit,oauth.complete,ui.resolve}` im
   Befehlsinventar (Vorschlag E40), über den v4-Befehlsweg statt Gast-JS.
2. Projektion `toolhub_connections` / `ui_requests` als Collection-Read.
3. Geheimnisse nur im Kern; OAuth führt der Kern aus, das Login-Fenster
   bekommt seine Origin aus dem `V4LaunchContext`, nicht aus dem Gast.
4. Danach UI neu: Schnittstellen-Seite und Chat-Karten auf dieser Grundlage,
   nicht durch Wiederbeleben der entfernten Symbole (der Wächter verbietet sie).
