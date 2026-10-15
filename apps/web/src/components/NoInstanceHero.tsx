import { PlusIcon } from "lucide-react";
import { openInstanceSetup } from "../instanceSetup";
import { Button } from "./ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

/** Leerzustand im Hauptbereich, solange keine Instanz gewählt ist. */
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
              <EmptyTitle className="text-[22px] text-foreground">Instanz verbinden</EmptyTitle>
              <div className="mt-6 flex justify-center">
                <Button
                  size="sm"
                  data-workjet-action="instance.connect.empty"
                  onClick={() => openInstanceSetup()}
                >
                  <PlusIcon className="size-4" />
                  Instanz hinzufügen
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
