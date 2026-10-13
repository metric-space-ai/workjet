import { ChevronDownIcon, InfoIcon, Undo2Icon, Trash2Icon } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type ComponentPropsWithoutRef,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { InlineExpand } from "../ui/inline-expand";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface SettingsSearchTargetContextValue {
  readonly targetId: string | null;
  readonly onTargetHandled: () => void;
}

const noop = () => undefined;
const SettingsSearchTargetContext = createContext<SettingsSearchTargetContextValue>({
  targetId: null,
  onTargetHandled: noop,
});

export function SettingsSearchTargetProvider({
  targetId,
  onTargetHandled = noop,
  children,
}: {
  targetId: string | null;
  onTargetHandled?: () => void;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ targetId, onTargetHandled }), [onTargetHandled, targetId]);
  return <SettingsSearchTargetContext value={value}>{children}</SettingsSearchTargetContext>;
}

function scrollAndFocusSettingsTarget(target: HTMLElement): void {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollTarget =
    target.tagName === "SECTION" && target.firstElementChild
      ? (target.firstElementChild as HTMLElement)
      : target;

  scrollTarget.scrollIntoView({
    behavior: prefersReducedMotion ? "auto" : "smooth",
    block: "center",
  });
  target.focus({ preventScroll: true });
  target.classList.remove("settings-search-target-pulse");
  if (prefersReducedMotion) return;
  void target.offsetWidth;
  target.classList.add("settings-search-target-pulse");
  // The class also suppresses the focus outline (the pulse is the destination
  // indicator), so drop it once the element is no longer the destination.
  target.addEventListener("blur", () => target.classList.remove("settings-search-target-pulse"), {
    once: true,
  });
}

/** The row id a settings-search jump is currently trying to reach, if any. */
export function useSettingsSearchTargetId(): string | null {
  return useContext(SettingsSearchTargetContext).targetId;
}

function useSettingsSearchTarget<T extends HTMLElement>(id: string | undefined) {
  const { targetId, onTargetHandled } = useContext(SettingsSearchTargetContext);
  const isSearchTarget = id !== undefined && id === targetId;
  const targetRef = useCallback(
    (target: T | null) => {
      if (target && isSearchTarget) {
        scrollAndFocusSettingsTarget(target);
        onTargetHandled();
      }
    },
    [isSearchTarget, onTargetHandled],
  );

  return targetRef;
}

/**
 * Info-Zeichen mit Tooltip (UI-Vertrag: Tooltips erlaubt, kein Popover mit
 * Text). Nur für eine kurze Bezeichnung, nie für Erklärabsätze.
 */
export function PolicyTooltip({ children }: { readonly children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground"
            aria-label={children}
          >
            <InfoIcon className="size-3.5" />
          </span>
        }
      />
      <TooltipPopup side="top">{children}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Two-step delete: the first click ARMS the button (it turns into a red
 * "Delete?" for four seconds), the second click deletes. Introduced after the
 * interactive review found every list delete fired instantly from an
 * always-visible trash icon — one stray click destroyed a configured entry
 * with no confirmation, no undo.
 */
export function ConfirmingDeleteButton({
  label,
  onDelete,
}: {
  readonly label: string;
  readonly onDelete: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4_000);
    return () => clearTimeout(id);
  }, [armed]);
  return armed ? (
    <Button
      type="button"
      size="xs"
      variant="destructive"
      aria-label={`${label} wirklich löschen`}
      onClick={() => {
        setArmed(false);
        onDelete();
      }}
    >
      Löschen?
    </Button>
  ) : (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={`${label} löschen`}
      onClick={() => setArmed(true)}
    >
      <Trash2Icon className="size-3.5" />
    </Button>
  );
}

/** Re-render every `intervalMs`; return a stable timestamp snapshot for render-time relative labels. */
export function useRelativeTimeTick(intervalMs = 1_000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

export function SettingsSection({
  title,
  icon,
  headerAction,
  collapsible,
  children,
  className,
  ...sectionProps
}: ComponentPropsWithoutRef<"section"> & {
  title: string;
  icon?: ReactNode;
  headerAction?: ReactNode;
  /** Abschnitt klappt über die Überschrift auf (immer nur einer offen). */
  collapsible?: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void };
  children: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLElement>(sectionProps.id);

  return (
    <section
      {...sectionProps}
      ref={targetRef}
      tabIndex={sectionProps.id ? -1 : sectionProps.tabIndex}
      className={cn("space-y-1.5", className)}
    >
      <div className="flex min-h-8 items-center justify-between gap-4 px-3 sm:px-4">
        <h2 className="flex items-center gap-2 text-[13.5px] font-semibold text-foreground">
          {collapsible ? (
            <button
              type="button"
              aria-expanded={collapsible.open}
              className="-mx-1 flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
              data-slot="settings-section-toggle"
              onClick={() => collapsible.onOpenChange(!collapsible.open)}
            >
              {icon}
              {title}
              <ChevronDownIcon
                aria-hidden
                className={cn(
                  "size-4 text-muted-foreground transition-transform duration-200",
                  collapsible.open && "rotate-180",
                )}
              />
            </button>
          ) : (
            <>
              {icon}
              {title}
            </>
          )}
        </h2>
        {collapsible && !collapsible.open ? null : (
          <div className="flex min-h-7 min-w-7 items-center justify-end">{headerAction}</div>
        )}
      </div>
      {collapsible ? (
        <InlineExpand
          hideCollapseControl
          label={title}
          open={collapsible.open}
          onOpenChange={collapsible.onOpenChange}
        >
          <div className="relative space-y-1 overflow-visible text-foreground">{children}</div>
        </InlineExpand>
      ) : (
        <div className="relative space-y-1 overflow-visible text-foreground">{children}</div>
      )}
    </section>
  );
}

/**
 * Einstellungszeile (UI-Vertrag §1.4): Bezeichnung (höchstens 3 Wörter) und
 * Steuerelement, optional eine Statuszeile. Keine Beschreibung.
 */
export function SettingsRow({
  title,
  status,
  resetAction,
  control,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(rowProps.id);

  return (
    <div
      {...rowProps}
      ref={targetRef}
      tabIndex={rowProps.id ? -1 : rowProps.tabIndex}
      className={cn(
        "border-b border-border/60 px-3 last:border-b-0 sm:px-4",
        children ? "pt-2.5 pb-1" : "py-2.5",
        className,
      )}
    >
      <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-[13.5px] font-medium text-foreground">{title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingResetButton({
  label,
  disabled = false,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`${label} zurücksetzen`}
            disabled={disabled}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Zurücksetzen</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Set when a settings page renders inline inside a list row (e.g. a project
 * under Einstellungen › Projekte) instead of as its own page.
 */
export const SettingsEmbeddedContext = createContext<{ readonly onClose: () => void } | null>(null);

export function useSettingsEmbedded() {
  return useContext(SettingsEmbeddedContext);
}

function SettingsPageTitle({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <h1 className="flex min-w-0 items-center gap-2 px-3 text-xl font-semibold tracking-[-0.025em] break-words sm:px-4">
      {icon}
      {children}
    </h1>
  );
}

export function SettingsPageContainer({
  children,
  className,
  title,
  titleIcon,
}: {
  children: ReactNode;
  className?: string;
  /** The one page title style (#564); pages never render their own h1/h2. */
  title?: ReactNode;
  titleIcon?: ReactNode;
}) {
  const embedded = useContext(SettingsEmbeddedContext);
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const targetId = hash.replace(/^#/, "") || null;
  const clearTargetHash = useCallback(() => {
    void navigate({ hash: "", replace: true, resetScroll: false, hashScrollIntoView: false });
  }, [navigate]);

  if (embedded) {
    return <div className={cn("flex w-full flex-col gap-4 pb-3 pt-1", className)}>{children}</div>;
  }
  return (
    <SettingsSearchTargetProvider targetId={targetId} onTargetHandled={clearTargetHash}>
      <div
        className={cn(
          "settings-page-scroll-fade scrollbar-gutter-both flex-1 overflow-y-auto px-4 pb-7 sm:pb-10",
          "pt-4 sm:px-5 sm:pt-5",
        )}
      >
        <div className={cn("flex w-full flex-col gap-5", "mx-auto max-w-4xl", className)}>
          {title ? <SettingsPageTitle icon={titleIcon}>{title}</SettingsPageTitle> : null}
          {children}
        </div>
      </div>
    </SettingsSearchTargetProvider>
  );
}

export function scrollToSettingsTarget(targetId: string): boolean {
  const target = document.getElementById(targetId);
  if (!target) return false;
  scrollAndFocusSettingsTarget(target);
  return true;
}
