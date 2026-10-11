/**
 * Banner (UI-Vertrag §1): Icon, eine Zeile, ein bis zwei Buttons.
 * Keine Absätze, keine Überschrift.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export interface BannerAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface BannerProps {
  readonly icon: LucideIcon;
  /** Eine Zeile, höchstens 12 Wörter (Wächter §8a). */
  readonly children: ReactNode;
  /** Primäraktion. */
  readonly action?: BannerAction;
  /** Zweite, sekundäre Aktion. */
  readonly secondaryAction?: BannerAction;
  readonly className?: string;
}

function Banner({ icon: Icon, children, action, secondaryAction, className }: BannerProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-[13.5px]",
        className,
      )}
      data-slot="banner"
      role="status"
    >
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate" data-slot="banner-text">
        {children}
      </span>
      {secondaryAction ? (
        <Button size="sm" variant="outline" onClick={secondaryAction.onClick}>
          {secondaryAction.label}
        </Button>
      ) : null}
      {action ? (
        <Button size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

export { Banner };
