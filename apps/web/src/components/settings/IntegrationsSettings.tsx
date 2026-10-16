// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Einstellungen → Schnittstellen: verbundene Apps als Zeilen (UI-Vertrag §1.2),
 * „+ Hinzufügen“ im Kopf wie unter „Modelle“; die gewählte App erscheint als
 * Zeile am Listenanfang (Audit C 4, 7, 8, 29).
 *
 * Zustand kommt immer von der CTOX-Instanz (`useToolhubIntegrations`).
 *
 * Nur im Entwicklermodus, bis ctox #708 und die Übergabe Main-Prozess →
 * Instanz stehen: ohne Entwicklermodus wird nichts gemountet, es gibt also
 * weder Abfragen noch Desktop-IPC.
 */
import { Loader2Icon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useUiText } from "../../hooks/useUiText";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "../ui/empty";
import { InlineExpand } from "../ui/inline-expand";
import { Row } from "../ui/row";
import { CredentialCard } from "../toolhub/ToolhubCards";
import {
  INTEGRATIONS,
  INTEGRATION_CATEGORIES,
  isToolhubConnect,
  type IntegrationEntry,
} from "./integrationsCatalog";
import { SettingsAddButton, SettingsLoadingRow, type SettingsAddOption } from "./settingsAdd";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useToolhubIntegrations, type ToolhubIntegrations } from "./useToolhubIntegrations";

/**
 * Nur Einträge mit Toolhub-Anschluss erscheinen; „Bald verfügbar“-Einträge gibt
 * es nicht, native Kalender-Anmeldungen leben unter Instanz › Kalender-Konten.
 */
export const CONNECTABLE_INTEGRATIONS: ReadonlyArray<IntegrationEntry> = INTEGRATIONS.filter((e) =>
  isToolhubConnect(e.connect),
);

export function IntegrationLogo({ entry }: { readonly entry: IntegrationEntry }) {
  return (
    <span
      aria-hidden
      className="flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-white"
    >
      {entry.logo ? (
        <img src={entry.logo} alt="" className="size-full object-contain" draggable={false} />
      ) : (
        <span className="text-[11px] font-semibold text-neutral-700">{entry.name.slice(0, 1)}</span>
      )}
    </span>
  );
}

function categoryLabel(entry: IntegrationEntry, t: (de: string, en: string) => string) {
  const category = INTEGRATION_CATEGORIES.find((c) => c.id === entry.category);
  return category ? t(category.de, category.en) : undefined;
}

/** Menüeinträge für „+ Hinzufügen“: nur verbindbare, noch nicht verbundene Apps. */
export function integrationAddOptions(
  entries: ReadonlyArray<IntegrationEntry>,
  hub: Pick<ToolhubIntegrations, "isConnected" | "isExpired">,
  onSelect: (entry: IntegrationEntry) => void,
): SettingsAddOption[] {
  return entries
    .filter(
      (entry) =>
        isToolhubConnect(entry.connect) && !hub.isConnected(entry) && !hub.isExpired(entry),
    )
    .map((entry) => ({
      key: entry.slug,
      label: (
        <span className="flex items-center gap-2">
          <IntegrationLogo entry={entry} />
          {entry.name}
        </span>
      ),
      action: `integrations.add.${entry.slug}`,
      onSelect: () => onSelect(entry),
    }));
}

/**
 * Die gewählte App als Zeile am Listenanfang: Verbinden (MCP) oder Schlüssel
 * (Token), ein Fehler mit genau einer Aktion; „Entfernen“ verwirft die Zeile.
 */
export function IntegrationDraftRow({
  entry,
  hub,
  onDone,
}: {
  readonly entry: IntegrationEntry;
  readonly hub: ToolhubIntegrations;
  readonly onDone: () => void;
}) {
  const t = useUiText();
  const [failed, setFailed] = useState(false);
  const busy = hub.busy === entry.slug;
  const connect = async () => {
    setFailed(false);
    const result = await hub.connectMcp(entry);
    if (result === true) onDone();
    else if (result === false) setFailed(true);
  };
  return (
    <div data-integration-draft={entry.slug}>
      <Row
        className="py-1.5"
        name={
          <span className="flex min-w-0 items-center gap-2">
            <IntegrationLogo entry={entry} />
            <span className="truncate">{entry.name}</span>
          </span>
        }
        meta={<span className="pl-6">{categoryLabel(entry, t)}</span>}
        onDelete={onDone}
        undoableDelete
        deleteLabel={t("Entfernen", "Remove")}
      />
      {entry.connect === "mcp" ? (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-9">
          <Button
            size="xs"
            disabled={busy || !hub.available}
            data-workjet-action={`integrations.connect.${entry.slug}`}
            onClick={() => void connect()}
          >
            {busy ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
            {t("Verbinden", "Connect")}
          </Button>
        </div>
      ) : (
        <div className="px-3 pb-2 pl-9">
          <CredentialCard
            t={t}
            appName={entry.name}
            title={t(`${entry.name}-Schlüssel`, `${entry.name} key`)}
            help=""
            secrets={[{ name: "token", secret: true }]}
            params={hub.connectionFields[entry.slug] ?? []}
            busy={busy}
            disabled={!hub.available}
            onSubmit={(values) => {
              setFailed(false);
              void hub.saveToken(entry, values).then((ok) => (ok ? onDone() : setFailed(true)));
            }}
          />
        </div>
      )}
      {failed ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-9 text-xs text-destructive"
        >
          <span>{t("Nicht verbunden.", "Not connected.")}</span>
          {entry.connect === "mcp" ? (
            <Button size="xs" variant="outline" onClick={() => void connect()}>
              {t("Erneut versuchen", "Try again")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConnectedIntegrationRow({
  entry,
  hub,
  expanded,
  onToggle,
}: {
  readonly entry: IntegrationEntry;
  readonly hub: ToolhubIntegrations;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const t = useUiText();
  const expired = hub.isExpired(entry);
  const tools = hub.catalog[entry.slug] ?? [];
  const [reconnecting, setReconnecting] = useState(false);
  return (
    <li data-integration-row={entry.slug}>
      <Row
        className="py-1.5"
        status={expired ? "error" : "ok"}
        statusLabel={expired ? t("Abgelaufen", "Expired") : t("Verbunden", "Connected")}
        name={
          <span className="flex min-w-0 items-center gap-2">
            <IntegrationLogo entry={entry} />
            <span className="truncate">{entry.name}</span>
          </span>
        }
        meta={<span className="pl-6">{categoryLabel(entry, t)}</span>}
        expanded={expanded}
        onToggleExpanded={onToggle}
        onDelete={() => void hub.remove(entry)}
        deleteLabel={t("Trennen", "Disconnect")}
        deleteConfirmTitle={t(`${entry.name} trennen?`, `Disconnect ${entry.name}?`)}
      />
      {expired ? (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-9 text-xs text-destructive">
          <span>{t("Anmeldung abgelaufen.", "Sign-in expired.")}</span>
          <Button
            size="xs"
            variant="outline"
            disabled={hub.busy === entry.slug || !hub.available}
            onClick={() => {
              if (entry.connect === "mcp") void hub.connectMcp(entry);
              else setReconnecting(true);
            }}
          >
            {t("Neu verbinden", "Reconnect")}
          </Button>
        </div>
      ) : null}
      {reconnecting && entry.connect === "token" ? (
        <IntegrationDraftRow entry={entry} hub={hub} onDone={() => setReconnecting(false)} />
      ) : null}
      <InlineExpand label={entry.name} open={expanded} onOpenChange={onToggle} hideCollapseControl>
        {tools.length > 0 ? (
          <section className="flex flex-col gap-1 px-3 pb-2 pl-9">
            <h3 className="text-xs font-medium text-muted-foreground">{t("Werkzeuge", "Tools")}</h3>
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {tools.map((x) => (
                <li
                  key={x.name}
                  className="flex items-center justify-between gap-3 px-3 py-1.5 text-[13.5px]"
                >
                  <span className="min-w-0 truncate">{x.title || x.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {x.mutating ? t("fragt vorher", "asks first") : t("nur lesen", "read only")}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </InlineExpand>
    </li>
  );
}

export function IntegrationsSettingsPanel() {
  const developerMode = useClientSettings((s) => s.developerMode);
  return developerMode ? <IntegrationsStore /> : null;
}

function IntegrationsStore() {
  const t = useUiText();
  const hub = useToolhubIntegrations();
  const [draft, setDraft] = useState<IntegrationEntry | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const connected = CONNECTABLE_INTEGRATIONS.filter(
    (entry) => hub.isConnected(entry) || hub.isExpired(entry),
  );
  const options = integrationAddOptions(CONNECTABLE_INTEGRATIONS, hub, (entry) => {
    setExpanded(null);
    setDraft(entry);
  });
  const add =
    options.length > 0 ? (
      <SettingsAddButton action="integrations.add" disabled={!hub.loaded} options={options} />
    ) : null;
  return (
    <SettingsPageContainer>
      <SettingsSection
        title={t("Schnittstellen", "Integrations")}
        data-integrations-store=""
        headerAction={draft === null ? add : null}
      >
        {draft !== null ? (
          <div className="rounded-lg border">
            <IntegrationDraftRow entry={draft} hub={hub} onDone={() => setDraft(null)} />
          </div>
        ) : null}
        {!hub.loaded ? (
          <SettingsLoadingRow onRetry={() => void hub.refresh()} />
        ) : connected.length > 0 ? (
          <ul
            aria-label={t("Verbundene Apps", "Connected apps")}
            className="divide-y divide-border/50 rounded-lg border"
          >
            {connected.map((entry) => (
              <ConnectedIntegrationRow
                key={entry.slug}
                entry={entry}
                hub={hub}
                expanded={expanded === entry.slug}
                onToggle={() => {
                  const next = expanded === entry.slug ? null : entry.slug;
                  setExpanded(next);
                  if (next !== null && entry.connect === "mcp") void hub.loadMcpTools(entry.slug);
                }}
              />
            ))}
          </ul>
        ) : draft === null ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyTitle className="text-[13.5px]">
                {t("Keine Schnittstellen", "No integrations")}
              </EmptyTitle>
            </EmptyHeader>
            {add ? <EmptyContent>{add}</EmptyContent> : null}
          </Empty>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
