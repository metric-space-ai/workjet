import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { startNewThreadFromContext } from "../lib/chatThreadActions";

/**
 * Keine Unterhaltung gewählt (D50): ein Titel in 22 px und genau ein
 * Primärknopf „Neue Unterhaltung“; die Kopfzeile bleibt leer.
 */
export function NoActiveThreadState() {
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const canStart = defaultProjectRef !== null;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            isElectron ? "workspace-topbar drag-region" : "workspace-topbar",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        />

        <Empty className="flex-1">
          <EmptyHeader className="max-w-none">
            <EmptyTitle className="text-foreground text-[22px]">Keine Unterhaltung</EmptyTitle>
          </EmptyHeader>
          {canStart ? (
            <EmptyContent>
              <Button
                onClick={() =>
                  void startNewThreadFromContext({
                    activeDraftThread,
                    activeThread: activeThread ?? undefined,
                    defaultProjectRef,
                    handleNewThread,
                  })
                }
              >
                Neue Unterhaltung
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      </div>
    </SidebarInset>
  );
}
