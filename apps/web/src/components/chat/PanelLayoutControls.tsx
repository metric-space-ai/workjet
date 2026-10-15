import { Maximize2Icon, Minimize2Icon, PanelRightIcon, SquareTerminalIcon } from "lucide-react";
import { memo } from "react";

import { useUiText } from "../../hooks/useUiText";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PanelLayoutControlsProps {
  showTerminalControl?: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  /** Running + waiting subagents in this thread; badges the right panel toggle. */
  liveAgentCount: number;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  showTerminalControl = true,
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  liveAgentCount,
  onToggleTerminal,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  const t = useUiText();
  const workers = (count: number) =>
    count === 1
      ? t("1 Worker aktiv", "1 worker active")
      : t(`${count} Worker aktiv`, `${count} workers active`);
  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      {showTerminalControl ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 gap-1.5 [-webkit-app-region:no-drag]"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label={t("Terminal", "Terminal")}
                variant="ghost"
                size="sm"
                disabled={!terminalAvailable}
              >
                {/* Own terminal glyph plus a word: never two near-identical panel rectangles (#593). */}
                <SquareTerminalIcon className="size-3.5" />
                <span className="text-xs max-md:sr-only">{t("Terminal", "Terminal")}</span>
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? (terminalShortcutLabel ?? t("Terminal", "Terminal"))
              : t("Terminal nicht verfügbar", "Terminal unavailable")}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className="relative shrink-0 gap-1.5 [-webkit-app-region:no-drag]"
              pressed={rightPanelOpen}
              onPressedChange={onToggleRightPanel}
              aria-label={
                liveAgentCount > 0
                  ? `${t("Arbeitsbereich", "Workspace")}, ${workers(liveAgentCount)}`
                  : t("Arbeitsbereich", "Workspace")
              }
              variant="ghost"
              size="sm"
              disabled={!rightPanelAvailable}
            >
              <PanelRightIcon className="size-3.5" />
              <span className="text-xs max-md:sr-only">{t("Arbeitsbereich", "Workspace")}</span>
              {liveAgentCount > 0 ? (
                <span
                  aria-hidden
                  className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
                >
                  {liveAgentCount}
                </span>
              ) : null}
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {rightPanelAvailable
            ? [rightPanelShortcutLabel, liveAgentCount > 0 ? workers(liveAgentCount) : null]
                .filter(Boolean)
                .join(" · ") || t("Arbeitsbereich", "Workspace")
            : t("Arbeitsbereich nicht verfügbar", "Workspace unavailable")}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const t = useUiText();
  const label = maximized
    ? t("Panelgröße zurücksetzen", "Restore panel size")
    : t("Panel maximieren", "Maximize panel");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            {maximized ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
