// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Instanz → Kalender-Konten (Audit C 10): die Kalender-Konten der gewählten
 * Instanz als Zeilen, ohne Entwicklermodus erreichbar und über die Suche
 * „Kalender“ auffindbar. „+ Hinzufügen“ erscheint, sobald der Katalog eine
 * verbindbare Kalender-App führt; erst dann wird der Toolhub gemountet.
 * Google Kalender verbindet nativ über die Instanz (ctox #875) und erscheint
 * nur, wenn deren Core die Anmeldung kennt.
 */
import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkjetCalendarAccounts } from "@workjet/contracts";

import {
  CALENDAR_CONNECT_FAILURES,
  connectGoogleCalendar,
  probeCalendarConnect,
  type CalendarAuthorizePort,
  type CalendarConnectFailure,
} from "../../calendar/calendarConnect";
import { NativeAccountCalendar } from "../../calendar/nativeAccountCalendar";
import { Button } from "../ui/button";
import { Row } from "../ui/row";
import {
  CONNECTABLE_INTEGRATIONS,
  IntegrationDraftRow,
  IntegrationLogo,
  integrationAddOptions,
} from "./IntegrationsSettings";
import { CALENDAR_OAUTH_INTEGRATIONS, type IntegrationEntry } from "./integrationsCatalog";
import { SettingsAddButton, SettingsLoadingRow, type SettingsAddOption } from "./settingsAdd";
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
export type GoogleDraft =
  | { readonly phase: "pending" }
  | { readonly phase: "failed"; readonly code: CalendarConnectFailure };
const GOOGLE_CALENDAR = CALENDAR_OAUTH_INTEGRATIONS.find(
  (entry) => entry.slug === "google-calendar",
);

function calendarAuthorizePort(): CalendarAuthorizePort | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.calendarAuthorize;
}

/** Nur wenn Desktop-Fenster und Core die Anmeldung kennen; sonst kein Menüeintrag. */
export function useCalendarConnectSupport(
  instanceId: string,
  probe: typeof probeCalendarConnect = probeCalendarConnect,
): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let live = true;
    setSupported(false);
    if (GOOGLE_CALENDAR === undefined || calendarAuthorizePort() === undefined) return;
    void probe(instanceId).then((ok) => {
      if (live) setSupported(ok);
    });
    return () => {
      live = false;
    };
  }, [instanceId, probe]);
  return supported;
}

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
  const [google, setGoogle] = useState<GoogleDraft | null>(null);
  const googleSupported = useCalendarConnectSupport(instanceId);
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
    setGoogle(null);
    void load();
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [load]);
  const section = searchableSetting("instance-calendar-accounts");
  const connectGoogle = useCallback(async () => {
    const authorize = calendarAuthorizePort();
    if (authorize === undefined) return;
    setGoogle({ phase: "pending" });
    try {
      const outcome = await connectGoogleCalendar(instanceId, {
        authorize,
        current: () => current.current === instanceId,
      });
      if (outcome._tag === "cancelled") setGoogle(null);
      else if (outcome._tag === "failed") setGoogle({ phase: "failed", code: outcome.code });
      else {
        setGoogle(null);
        const { id, calendar_id, label, supported } = outcome.account;
        setAccounts((prev) =>
          prev === null || prev.some((a) => a.id === id)
            ? prev
            : [...prev, { id, calendar_id, label, supported }],
        );
        void load();
      }
    } catch {
      // Instanz gewechselt: die Zeile gehört zur alten Instanz.
    }
  }, [instanceId, load]);
  const googleOption: SettingsAddOption[] =
    googleSupported && GOOGLE_CALENDAR !== undefined
      ? [
          {
            key: GOOGLE_CALENDAR.slug,
            label: (
              <span className="flex items-center gap-2">
                <IntegrationLogo entry={GOOGLE_CALENDAR} />
                {GOOGLE_CALENDAR.name}
              </span>
            ),
            action: `calendar.accounts.add.${GOOGLE_CALENDAR.slug}`,
            onSelect: () => void connectGoogle(),
          },
        ]
      : [];
  const options = [
    ...googleOption,
    ...(hub === null ? [] : integrationAddOptions(CALENDAR_INTEGRATIONS, hub, setDraft)),
  ];
  const add =
    options.length > 0 && draft === null && google === null ? (
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
      {google !== null && GOOGLE_CALENDAR !== undefined ? (
        <GoogleDraftRow
          entry={GOOGLE_CALENDAR}
          draft={google}
          onRetry={() => void connectGoogle()}
          onDismiss={() => setGoogle(null)}
        />
      ) : null}
      {accounts === null ? (
        <SettingsLoadingRow onRetry={() => void load()} />
      ) : accounts.length === 0 ? (
        draft === null && google === null ? (
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

/** Die Anmeldezeile am Listenanfang: Spinner, danach Konto oder Fehler mit genau einer Aktion. */
export function GoogleDraftRow({
  entry,
  draft,
  onRetry,
  onDismiss,
}: {
  readonly entry: IntegrationEntry;
  readonly draft: GoogleDraft;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}) {
  const failure = draft.phase === "failed" ? CALENDAR_CONNECT_FAILURES[draft.code] : null;
  return (
    <div className="rounded-lg border" data-workjet-calendar-connect={draft.phase}>
      <Row
        className="py-1.5"
        name={
          <span className="flex min-w-0 items-center gap-2">
            <IntegrationLogo entry={entry} />
            <span className="truncate">{entry.name}</span>
            {failure === null ? (
              <Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden />
            ) : null}
          </span>
        }
        {...(failure === null ? {} : { status: "error" as const })}
      />
      {failure !== null && draft.phase === "failed" ? (
        <div
          role="alert"
          data-workjet-calendar-connect-error={draft.code}
          className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-9 text-xs text-destructive"
        >
          <span>{failure.text}</span>
          <Button
            size="xs"
            variant="outline"
            data-workjet-action={
              failure.action === "retry"
                ? "calendar.accounts.connect.retry"
                : "calendar.accounts.connect.dismiss"
            }
            onClick={failure.action === "retry" ? onRetry : onDismiss}
          >
            {failure.action === "retry" ? "Erneut versuchen" : "Schließen"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
