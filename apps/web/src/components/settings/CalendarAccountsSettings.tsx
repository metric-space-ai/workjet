// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Instanz → Kalender-Konten (Audit C 10): die Kalender-Konten der gewählten
 * Instanz als Zeilen, ohne Entwicklermodus erreichbar und über die Suche
 * „Kalender“ auffindbar. „+ Hinzufügen“ erscheint, sobald der Katalog eine
 * verbindbare Kalender-App führt; erst dann wird der Toolhub gemountet.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkjetCalendarAccounts } from "@workjet/contracts";

import { NativeAccountCalendar } from "../../calendar/nativeAccountCalendar";
import { Row } from "../ui/row";
import {
  CONNECTABLE_INTEGRATIONS,
  IntegrationDraftRow,
  integrationAddOptions,
} from "./IntegrationsSettings";
import type { IntegrationEntry } from "./integrationsCatalog";
import { SettingsAddButton, SettingsLoadingRow } from "./settingsAdd";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useToolhubIntegrations, type ToolhubIntegrations } from "./useToolhubIntegrations";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "../ui/empty";

/** Kalender-Apps des Katalogs; nur verbindbare erscheinen im Menü. */
export const CALENDAR_INTEGRATION_SLUGS = ["google-calendar", "microsoft-outlook", "calendly"];
const CALENDAR_INTEGRATIONS = CONNECTABLE_INTEGRATIONS.filter((entry) =>
  CALENDAR_INTEGRATION_SLUGS.includes(entry.slug),
);
const RETRY_MS = 15_000;

type Accounts = WorkjetCalendarAccounts["accounts"];

export function CalendarAccountsSection({ instanceId }: { readonly instanceId: string }) {
  return CALENDAR_INTEGRATIONS.length > 0 ? (
    <CalendarAccountsWithHub instanceId={instanceId} />
  ) : (
    <CalendarAccountsView instanceId={instanceId} hub={null} />
  );
}

function CalendarAccountsWithHub({ instanceId }: { readonly instanceId: string }) {
  const hub = useToolhubIntegrations();
  return <CalendarAccountsView instanceId={instanceId} hub={hub} />;
}

function CalendarAccountsView({
  instanceId,
  hub,
}: {
  readonly instanceId: string;
  readonly hub: ToolhubIntegrations | null;
}) {
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [draft, setDraft] = useState<IntegrationEntry | null>(null);
  const current = useRef(instanceId);
  current.current = instanceId;
  const timer = useRef<number | null>(null);
  const load = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    const reader = new NativeAccountCalendar(instanceId, () => current.current === instanceId);
    try {
      const result = await reader.accounts();
      if (current.current === instanceId) setAccounts(result.accounts);
    } catch {
      // Still erneut; die Ladezeile endet nach 10 s mit „Erneut“.
      if (current.current === instanceId)
        timer.current = window.setTimeout(() => void load(), RETRY_MS);
    }
  }, [instanceId]);
  useEffect(() => {
    setAccounts(null);
    void load();
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [load]);
  const section = searchableSetting("instance-calendar-accounts");
  const options = hub === null ? [] : integrationAddOptions(CALENDAR_INTEGRATIONS, hub, setDraft);
  const add =
    options.length > 0 && draft === null ? (
      <SettingsAddButton action="calendar.accounts.add" options={options} />
    ) : null;
  return (
    <SettingsSection {...section} data-workjet-calendar-accounts="" headerAction={add}>
      {draft !== null && hub !== null ? (
        <div className="rounded-lg border">
          <IntegrationDraftRow
            entry={draft}
            hub={hub}
            onDone={() => {
              setDraft(null);
              void load();
            }}
          />
        </div>
      ) : null}
      {accounts === null ? (
        <SettingsLoadingRow onRetry={() => void load()} />
      ) : accounts.length === 0 ? (
        draft === null ? (
          <Empty className="py-4">
            <EmptyHeader>
              <EmptyTitle className="text-[13.5px]">Keine Kalender-Konten</EmptyTitle>
            </EmptyHeader>
            {add ? <EmptyContent>{add}</EmptyContent> : null}
          </Empty>
        ) : null
      ) : (
        <ul aria-label={section.title} className="divide-y divide-border/60">
          {accounts.map((account) => (
            <li key={account.id} data-workjet-calendar-account="">
              <Row
                name={account.label}
                status={account.supported ? "ok" : "off"}
                statusLabel={account.supported ? "Verbunden" : "Nicht unterstützt"}
              />
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
