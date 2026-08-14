import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarContent, SidebarGroup, SidebarInset } from "../ui/sidebar";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { cn } from "../../lib/utils";

export function CtoxSidebarShell() {
  return (
    <>
      <SidebarChromeHeader isElectron />
      <SidebarContent className="gap-0" data-ctox-sidebar-shell="">
        <SidebarGroup className="px-[calc(var(--sidebar-content-inset)+0.5rem)] py-5">
          <div className="rounded-lg border border-sidebar-border/70 bg-sidebar-accent/20 px-3 py-3">
            <p className="text-sm font-medium text-sidebar-foreground">No instance selected</p>
            <p className="mt-1 text-xs leading-relaxed text-sidebar-muted-foreground">
              Instance connections will appear here.
            </p>
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

export function CtoxMainShell() {
  return (
    <SidebarInset
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground"
      data-ctox-main-shell=""
    >
      <header
        className={cn(
          "workspace-topbar drag-region border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <span className="text-xs font-medium text-muted-foreground/60 wco:pr-[var(--workspace-native-controls-inset)]">
          CTOX
        </span>
      </header>
      <Empty className="flex-1">
        <div className="w-full max-w-lg px-8 py-12">
          <EmptyHeader className="max-w-none">
            <EmptyTitle className="text-xl text-foreground">No instance selected</EmptyTitle>
            <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
              Instance connections will appear here when CTOX guest support is available.
            </EmptyDescription>
          </EmptyHeader>
        </div>
      </Empty>
    </SidebarInset>
  );
}
