import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  return (SETTINGS_SECTION_LABELS as Readonly<Record<string, string>>)[normalizedPathname] ?? null;
}

function settingsWord(): string {
  const lang = typeof document === "undefined" ? "de" : document.documentElement.lang;
  return lang.toLowerCase().startsWith("en") ? "Settings" : "Einstellungen";
}

export function SettingsBreadcrumb({
  pathname,
  activeInstanceName = null,
}: {
  pathname: string;
  activeInstanceName?: string | null;
}) {
  const sectionLabel = settingsBreadcrumbLabel(pathname);

  return (
    <WorkspaceBreadcrumb ariaLabel={settingsWord()}>
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{settingsWord()}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          {activeInstanceName !== null && pathname !== "/settings/business-os" ? (
            <>
              <WorkspaceBreadcrumbItem className="truncate">
                {activeInstanceName}
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator />
            </>
          ) : null}
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? settingsWord()}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
