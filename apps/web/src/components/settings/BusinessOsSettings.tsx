import { BriefcaseBusinessIcon, CircleAlertIcon } from "lucide-react";

import type { CrossModeTarget } from "../../crossMode/crossModeTarget";
import { crossModeSelectionMemory } from "../../crossMode/crossModeSelectionMemory";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/**
 * Settings never invent an instance from the Code environment or the primary
 * server. Until the shared persisted binding lands, the Business OS selection
 * memory is the only renderer state that truthfully names the active backend.
 */
export function resolveActiveBusinessOsInstanceId(target: CrossModeTarget | null): string | null {
  return target?.mode === "business-os" && target.ctoxInstanceId !== undefined
    ? target.ctoxInstanceId
    : null;
}

export function BusinessOsSettingsView({
  activeInstanceId,
}: {
  readonly activeInstanceId: string | null;
}) {
  return (
    <SettingsPageContainer className="gap-6">
      <div className="px-3 sm:px-4">
        <h1 className="text-xl font-semibold tracking-[-0.025em]">Business OS</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Einstellungen für die aktive Business-OS-Instanz. Der Wechsel zwischen Code und Business
          OS ändert die ausgewählte Instanz nicht.
        </p>
      </div>

      <SettingsSection title="Aktive Business-OS-Instanz">
        {activeInstanceId === null ? (
          <div
            className="flex max-w-2xl items-start gap-3 rounded-lg border border-warning/35 bg-warning/8 p-4"
            role="status"
          >
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div>
              <p className="text-sm font-medium text-foreground">
                Keine Business-OS-Instanz ausgewählt
              </p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                Wähle zuerst in Business OS eine Instanz aus. Instanzbezogene Einstellungen bleiben
                bis dahin gesperrt, damit Workjet keine Daten verschiedener Instanzen vermischt.
              </p>
            </div>
          </div>
        ) : (
          <div
            className="flex max-w-2xl items-start gap-3 rounded-lg border border-border bg-muted/20 p-4"
            data-active-ctox-instance={activeInstanceId}
          >
            <BriefcaseBusinessIcon
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Instanz ausgewählt</p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                Alle instanzbezogenen Einstellungen auf dieser Seite gelten ausschließlich für die
                aktive Business-OS-Instanz.
              </p>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Workjet-Geräte">
        <div className="max-w-2xl rounded-lg border border-border p-4">
          <p className="text-sm font-medium text-foreground">
            {activeInstanceId === null ? "Keine Instanz ausgewählt" : "Geräte dieser Instanz"}
          </p>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {activeInstanceId === null
              ? "Gerätefreigaben werden erst angezeigt, nachdem eine Business-OS-Instanz ausgewählt wurde."
              : "Gerätefreigaben werden hier erst angezeigt, sobald Workjet sie eindeutig dieser Instanz zuordnen kann."}
          </p>
        </div>
      </SettingsSection>

      <SettingsSection title="Rechner für Code">
        <div className="max-w-2xl rounded-lg border border-border p-4">
          <p className="text-sm font-medium text-foreground">Rechner getrennt verwalten</p>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            Rechner und ihre Coding-Werkzeuge werden unter „Computers“ verwaltet. Eine Zuordnung zu
            dieser Business-OS-Instanz wird nur angezeigt, wenn Workjet sie ausdrücklich kennt.
          </p>
          <a
            className="mt-3 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
            href="#/settings/computers"
          >
            Rechner öffnen
          </a>
        </div>
      </SettingsSection>

      <SettingsSection title="Diagnose">
        <div className="max-w-2xl rounded-lg border border-border p-4">
          <p className="text-sm font-medium text-foreground">Technischer Instanz-Scope</p>
          {activeInstanceId === null ? (
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Ohne aktive Business-OS-Instanz sind keine technischen CTOX-Backend-Details verfügbar.
            </p>
          ) : (
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              Technische CTOX-Backend-ID: {activeInstanceId}
            </p>
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function BusinessOsSettings() {
  const activeInstanceId = resolveActiveBusinessOsInstanceId(
    crossModeSelectionMemory.read("business-os"),
  );
  return <BusinessOsSettingsView activeInstanceId={activeInstanceId} />;
}
