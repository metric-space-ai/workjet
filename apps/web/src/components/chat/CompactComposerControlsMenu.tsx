import { ProviderInteractionMode } from "@workjet/contracts";
import { createContext, memo, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SettingsIcon } from "lucide-react";
import { workjetUiLanguage } from "../../workjetProjectControl";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

/** Sichtbarer und zugänglicher Name des Zahnrad-Menüs. */
export const COMPOSER_OPTIONS_MENU_LABEL = "Optionen";

function composerOptionsLabel(): string {
  return workjetUiLanguage() === "en" ? "Options" : COMPOSER_OPTIONS_MENU_LABEL;
}

/**
 * Inline-Zeilen des Composers (Systemprompt): Ein Eintrag im Optionen-Menü
 * öffnet sie, sie selbst stehen als Zeile unter der Composer-Leiste – nie als
 * Popup. Dasselbe Element wird einmal im Menü (`placement: "menu"`) und
 * einmal außerhalb (`placement: "row"`) gerendert; der Zustand lebt hier, weil
 * das Menü beim Klick schließt und seinen Inhalt aushängt.
 */
export interface ComposerInlineRowContextValue {
  readonly placement: "menu" | "row";
  readonly openRow: string | null;
  readonly setOpenRow: (row: string | null) => void;
  /** Das Zahnrad; von dort aus wird der Fuß des Composers gefunden. */
  readonly anchor: HTMLElement | null;
}

const ComposerInlineRowContext = createContext<ComposerInlineRowContextValue | null>(null);

export function useComposerInlineRow(): ComposerInlineRowContextValue | null {
  return useContext(ComposerInlineRowContext);
}

/** Wohin die Zeile gehört: ans Ende der Composer-Fläche, direkt unter den Fuß. */
export function composerInlineRowHost(anchor: HTMLElement | null): HTMLElement | null {
  const footer = anchor?.closest<HTMLElement>('[data-chat-composer-footer="true"]') ?? null;
  return footer?.parentElement ?? null;
}

/** Hängt die Zeile unter den Composer-Fuß; ohne Composer bleibt sie an Ort und Stelle. */
export function ComposerInlineRow({ children }: { readonly children: ReactNode }) {
  const context = useComposerInlineRow();
  const host = composerInlineRowHost(context?.anchor ?? null);
  return host ? createPortal(children, host) : <>{children}</>;
}

export interface CompactComposerControlsMenuProps {
  interactionMode: ProviderInteractionMode;
  showInteractionModeToggle: boolean;
  /** Worker + Computer groups, so both choices exist below the breakpoint. */
  workerMenuContent?: ReactNode;
  extraMenuContent?: ReactNode;
  traitsMenuContent?: ReactNode;
  /**
   * System Prompt stays reachable from the compact menu before Tools. The menu
   * holds only simple entries; the context meter is a chip in the bar.
   */
  systemPromptMenuContent?: ReactNode;
  workjetMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
}

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(
  props: CompactComposerControlsMenuProps,
) {
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <CompactComposerControlsMenuView
      {...props}
      openRow={openRow}
      setOpenRow={setOpenRow}
      anchor={anchor}
      setAnchor={setAnchor}
    />
  );
});

/** Hook-frei, damit Tests den Menübaum direkt prüfen können. */
export function CompactComposerControlsMenuView(
  props: CompactComposerControlsMenuProps & {
    readonly openRow: string | null;
    readonly setOpenRow: (row: string | null) => void;
    readonly anchor: HTMLElement | null;
    readonly setAnchor: (anchor: HTMLElement | null) => void;
  },
) {
  const { openRow, setOpenRow, anchor, setAnchor } = props;
  const menuContext: ComposerInlineRowContextValue = {
    placement: "menu",
    openRow,
    setOpenRow,
    anchor,
  };
  const rowContext: ComposerInlineRowContextValue = { ...menuContext, placement: "row" };
  return (
    <>
      <Menu>
        <MenuTrigger
          ref={setAnchor}
          render={
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
              aria-label={composerOptionsLabel()}
            />
          }
        >
          <SettingsIcon aria-hidden="true" className="size-4" />
          {/* The word, not a hover tooltip, says what the gear does (#590). */}
          <span aria-hidden="true" className="text-xs max-sm:hidden">
            {composerOptionsLabel()}
          </span>
        </MenuTrigger>
        <MenuPopup align="start" side="top" className="max-w-80">
          <ComposerInlineRowContext.Provider value={menuContext}>
            {props.extraMenuContent ? (
              <>
                {props.extraMenuContent}
                <MenuDivider />
              </>
            ) : null}
            {props.workerMenuContent ? (
              <>
                {props.workerMenuContent}
                <MenuDivider />
              </>
            ) : null}
            {props.traitsMenuContent ? (
              <>
                {props.traitsMenuContent}
                <MenuDivider />
              </>
            ) : null}
            {props.systemPromptMenuContent ? (
              <>
                {props.systemPromptMenuContent}
                <MenuDivider />
              </>
            ) : null}
            {props.workjetMenuContent ? (
              <>
                {props.workjetMenuContent}
                <MenuDivider />
              </>
            ) : null}
            {props.showInteractionModeToggle ? (
              <MenuGroup>
                <MenuGroupLabel>{workjetUiLanguage() === "en" ? "Mode" : "Modus"}</MenuGroupLabel>
                <MenuRadioGroup
                  value={props.interactionMode}
                  onValueChange={(value) => {
                    if (!value || value === props.interactionMode) return;
                    props.onToggleInteractionMode();
                  }}
                >
                  <MenuRadioItem value="default">
                    {workjetUiLanguage() === "en" ? "Build" : "Bauen"}
                  </MenuRadioItem>
                  <MenuRadioItem value="plan">
                    {workjetUiLanguage() === "en" ? "Plan" : "Planen"}
                  </MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
            ) : null}
            {/* No Access group: permission is ALWAYS full by the operator's
                rule, and DEFAULT_RUNTIME_MODE is "full-access" already. */}
          </ComposerInlineRowContext.Provider>
        </MenuPopup>
      </Menu>
      {openRow !== null && props.systemPromptMenuContent ? (
        <ComposerInlineRowContext.Provider value={rowContext}>
          {props.systemPromptMenuContent}
        </ComposerInlineRowContext.Provider>
      ) : null}
    </>
  );
}
