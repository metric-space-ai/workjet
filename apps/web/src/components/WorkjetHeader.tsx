import { useLocation, useNavigate } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useCrossModeNavigator } from "../crossMode/useCrossModeNavigator";
import { isElectron } from "../env";
import type { WorkjetProductMode } from "../workjetProductMode";
import { ActiveCtoxInstanceSelector } from "./ActiveCtoxInstanceSelector";
import { ProviderUpdateHeaderChip } from "./ProviderUpdateLaunchNotification";
import { SlowRpcRequestChip } from "./SlowRpcRequestToastCoordinator";
import { VersionChip } from "./VersionChip";
import { PrivacyModeToggle } from "./ui/sensitive";
import { BrowserBusinessOsNavigation } from "./BrowserBusinessOsNavigation";
import { WorkjetProductModeSwitch } from "./sidebar/SidebarChrome";
import { SidebarTrigger } from "./ui/sidebar";
import { WorkjetHeaderSlotContext } from "./WorkjetHeaderSlots";

export function WorkjetHeaderFrame({
  mode,
  sidebarAvailable,
  children,
}: {
  readonly mode: WorkjetProductMode;
  readonly sidebarAvailable: boolean;
  readonly children: ReactNode;
}) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const navigateAcrossModes = useCrossModeNavigator();
  const inSettings = useLocation({
    select: (location) => location.pathname.startsWith("/settings"),
  });

  return (
    <WorkjetHeaderSlotContext value={slot}>
      <header
        aria-label="Workjet"
        className="workspace-topbar drag-region relative z-20 gap-2 border-b border-border bg-background"
        data-workjet-header=""
      >
        <div
          className="flex min-w-0 items-center gap-2 pl-[var(--workspace-controls-left)]"
          data-workjet-header-navigation=""
        >
          {sidebarAvailable ? <SidebarTrigger aria-label="Seitenleiste ein-/ausblenden" /> : null}
          {isElectron ? <ActiveCtoxInstanceSelector placement="header" /> : null}
          {isElectron ? (
            <WorkjetProductModeSwitch
              mode={mode}
              onBackdrop={false}
              onModeChange={(nextMode) => {
                // Aus den Einstellungen führen Dev und Ops immer zurück auf die
                // Arbeitsfläche, auch wenn der Modus schon gewählt ist.
                if (inSettings) void navigate({ to: "/" });
                if (nextMode === mode) return;
                void navigateAcrossModes({ mode: nextMode === "ctox" ? "business-os" : "code" });
              }}
            />
          ) : (
            <BrowserBusinessOsNavigation />
          )}
        </div>
        <div
          ref={setSlot}
          className="relative flex min-w-0 flex-1 items-center"
          data-workjet-header-slot=""
        />
        <ProviderUpdateHeaderChip />
        <SlowRpcRequestChip />
        <VersionChip />
        <PrivacyModeToggle mac={isMacPlatform()} />
        <button
          type="button"
          aria-label="Einstellungen"
          title="Einstellungen"
          className="no-drag mr-[var(--workspace-controls-right)] flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          data-workjet-header-settings=""
          onClick={() => void navigate({ to: "/settings" })}
        >
          <SettingsIcon className="size-4" aria-hidden />
          <span>{headerSettingsLabel()}</span>
        </button>
      </header>
      <div className="flex min-h-0 w-full flex-1 overflow-hidden" data-workjet-content="">
        {children}
      </div>
    </WorkjetHeaderSlotContext>
  );
}

function headerSettingsLabel(): string {
  const lang = typeof document === "undefined" ? "de" : document.documentElement.lang;
  return lang.toLowerCase().startsWith("en") ? "Settings" : "Einstellungen";
}

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}
