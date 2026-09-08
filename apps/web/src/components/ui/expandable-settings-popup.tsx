import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "./button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./popover";

export function ExpandableSettingsPopup({
  open,
  onOpenChange,
  trigger,
  title,
  list,
  detail,
  detailTitle,
  onBack,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger: ReactElement;
  readonly title: string;
  readonly list: ReactNode;
  readonly detail?: ReactNode;
  readonly detailTitle?: string;
  readonly onBack: () => void;
}) {
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const expanded = detail !== undefined && detail !== null;
  useEffect(() => {
    if (open && expanded) detailHeading.current?.focus();
  }, [open, expanded, detailTitle]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverPopup
        aria-label={expanded ? detailTitle : title}
        side="top"
        align="start"
        className={cn(
          "@container/settings max-w-[min(calc(100vw-1.5rem),var(--available-width))] motion-reduce:transition-none",
          expanded ? "w-[44rem]" : "w-80",
        )}
        viewportClassName="p-0 [--viewport-inline-padding:0px]"
      >
        <div
          className={cn(
            "grid min-w-0",
            expanded && "@min-[36rem]/settings:grid-cols-[17rem_minmax(0,1fr)]",
          )}
        >
          <div className={cn("min-w-0 p-2", expanded && "hidden @min-[36rem]/settings:block")}>
            <PopoverTitle className="px-2 py-2 text-sm">{title}</PopoverTitle>
            <div className="max-h-[min(32rem,calc(var(--available-height)-4rem))] overflow-y-auto">
              {list}
            </div>
          </div>
          {expanded ? (
            <section className="min-w-0 border-border/60 p-3 @min-[36rem]/settings:border-l">
              <div className="mb-3 flex items-center gap-2">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={onBack}
                  aria-label="Back to workers"
                >
                  <ArrowLeftIcon aria-hidden="true" className="size-4" />
                </Button>
                <h3
                  ref={detailHeading}
                  tabIndex={-1}
                  className="min-w-0 truncate text-sm font-medium outline-none"
                >
                  {detailTitle}
                </h3>
              </div>
              <div className="max-h-[min(36rem,calc(var(--available-height)-5rem))] overflow-y-auto overscroll-contain">
                <p className="mb-3 text-xs text-muted-foreground">
                  Changes stay in this draft until you save or discard them.
                </p>
                {detail}
              </div>
            </section>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
