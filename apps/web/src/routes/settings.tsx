import { RotateCcwIcon } from "lucide-react";
import {
  Navigate,
  Outlet,
  createFileRoute,
  redirect,
  useCanGoBack,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { useCtoxMode } from "../components/ctox/CtoxModeShell";
import { resolveSettingsInstanceContext } from "../components/settings/settingsInstanceContext";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkjetHeaderContent } from "../components/WorkjetHeaderSlots";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);

  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      Restore defaults
    </Button>
  );
}

function SettingsContentLayout() {
  const { discovery, selectedId } = useCtoxMode();
  const instanceContext = resolveSettingsInstanceContext(
    discovery,
    selectedId,
    typeof window !== "undefined" && window.desktopBridge?.ctox !== undefined,
  );
  const location = useLocation();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const [restoreSignal, setRestoreSignal] = useState(0);
  const isInstanceManagement = location.pathname === "/settings/business-os";
  const canShowSettings = isInstanceManagement || instanceContext.canEditInstanceSettings;
  const showRestoreDefaults =
    location.pathname === "/settings/general" && instanceContext.canEditInstanceSettings;
  const handleRestored = () => setRestoreSignal((value) => value + 1);
  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();

        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) {
          activeElement.blur();
        }

        // An open inline editor means unsaved work — Escape must not tear
        // down the whole settings view over it (Befund F14). Leaving a text
        // field is one Escape; closing the editor stays its Cancel button's
        // job; only a form-free view closes on Escape.
        if (document.querySelector("[data-settings-inline-editor]") !== null) {
          return;
        }

        navigateBackWithinApp();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navigateBackWithinApp]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkjetHeaderContent
          className={cn(
            "workspace-topbar drag-region px-3 sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex w-full min-w-0 items-center gap-2">
            <SettingsBreadcrumb
              pathname={location.pathname}
              activeInstanceName={
                instanceContext.isMultiInstance ? instanceContext.activeInstanceName : null
              }
            />
            {showRestoreDefaults ? (
              <div className="no-drag ms-auto flex items-center gap-2">
                <RestoreDefaultsButton onRestored={handleRestored} />
              </div>
            ) : null}
          </div>
        </WorkjetHeaderContent>

        <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
          {canShowSettings ? (
            <Outlet />
          ) : discovery === "loading" ? (
            <p role="status" className="px-6 py-8 text-sm text-muted-foreground">
              Loading instances …
            </p>
          ) : (
            <Navigate to="/settings/business-os" replace />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  return <SettingsContentLayout />;
}

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static" &&
      context.authGateState.status !== "desktop-local"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }

    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/business-os", replace: true });
    }
  },
  component: SettingsRouteLayout,
});
