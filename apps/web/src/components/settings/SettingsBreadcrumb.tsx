import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
};

function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  return SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null;
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
    <WorkspaceBreadcrumb ariaLabel="Einstellungen">
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>Einstellungen</WorkspaceBreadcrumbItem>
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
        {sectionLabel ?? "Einstellungen"}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
