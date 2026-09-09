import { useNavigate } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useCrossModeNavigator } from "../crossMode/useCrossModeNavigator";
import { isElectron } from "../env";
import type { WorkjetProductMode } from "../workjetProductMode";
import { ActiveCtoxInstanceSelector } from "./ActiveCtoxInstanceSelector";
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

  return (
    <WorkjetHeaderSlotContext value={slot}>
      <header
        aria-label="Workjet"
        className="workspace-topbar drag-region relative z-20 gap-2 border-b border-border bg-background pl-[var(--workspace-controls-left)] pr-[var(--workspace-controls-right)]"
        data-workjet-header=""
      >
        {sidebarAvailable ? <SidebarTrigger aria-label="Toggle main sidebar" /> : null}
        {isElectron ? <ActiveCtoxInstanceSelector placement="header" /> : null}
        {isElectron ? (
          <WorkjetProductModeSwitch
            mode={mode}
            onBackdrop={false}
            onModeChange={(nextMode) => {
              if (nextMode === mode) return;
              void navigateAcrossModes({ mode: nextMode === "ctox" ? "business-os" : "code" });
            }}
          />
        ) : (
          <span className="text-sm font-medium">Workjet</span>
        )}
        <div
          ref={setSlot}
          className="relative flex min-w-0 flex-1 items-center"
          data-workjet-header-slot=""
        />
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          className="no-drag flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => void navigate({ to: "/settings" })}
        >
          <SettingsIcon className="size-4" aria-hidden />
        </button>
      </header>
      <div className="flex min-h-0 w-full flex-1 overflow-hidden" data-workjet-content="">
        {children}
      </div>
    </WorkjetHeaderSlotContext>
  );
}
