import { PlusIcon } from "lucide-react";
import { openInstanceSetup } from "../instanceSetup";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

/** Shown in the main area when no CTOX instance is selected, so there is nothing to load. */
export function NoInstanceHero() {
  return (
    <SidebarInset
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground"
      data-workjet-no-instance=""
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-2xl sm:text-3xl">
                No CTOX instance is connected
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Projects, supervisors and the calendar live on a CTOX instance. This computer is not
                connected to one yet, so there is nothing to show. Connect an instance to load your
                projects.
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button
                  size="sm"
                  data-workjet-action="instance.connect.empty"
                  onClick={() => openInstanceSetup()}
                >
                  <PlusIcon className="size-4" />
                  Connect an instance
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
