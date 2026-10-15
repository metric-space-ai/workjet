"use client";

import type { DesktopPreviewColorScheme } from "@workjet/contracts";
import { MoreVertical } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { previewBridge } from "./previewBridge";

const COLOR_SCHEME_OPTIONS: ReadonlyArray<{
  value: DesktopPreviewColorScheme;
  label: string;
}> = [
  { value: "system", label: "System" },
  { value: "light", label: "Hell" },
  { value: "dark", label: "Dunkel" },
];

interface Props {
  /** Active preview tab id. Tab-targeting actions are disabled without it. */
  tabId: string | null;
  /**
   * True only after the desktop bridge has registered a `webContentsId` for
   * the active tab. Tab-targeting actions throw on the desktop side until
   * then; we disable those items so the menu doesn't fire silent no-ops.
   */
  hasWebContents: boolean;
  /** Current zoom factor as a number (1.0 = 100%). */
  zoomFactor: number;
  /** Emulated `prefers-color-scheme` for the guest page. */
  colorScheme: DesktopPreviewColorScheme;
  /** Fixed viewport modes expose the device toolbar and resize rails. */
  deviceToolbarVisible: boolean;
  /** Switches between fill-panel mode and a fixed responsive viewport. */
  onToggleDeviceToolbar: () => void;
  /** Whether the separate native always-on-top preview window is open. */
  nativePictureInPicture: boolean;
  /** Toggles the optional native always-on-top preview window. */
  onNativePictureInPicture: () => void;
}

/**
 * ⋯-Menü in der Vorschauleiste: nur einfache Einträge (drei Orte, keine
 * Popups). Kein Untermenü, keine eingebetteten Knöpfe; Zoom sind drei
 * eigene Einträge, die das Menü offen lassen. Nur gemountet, wenn die
 * Desktop-Brücke da ist.
 */
export function PreviewMoreMenu({
  tabId,
  hasWebContents,
  zoomFactor,
  colorScheme,
  deviceToolbarVisible,
  onToggleDeviceToolbar,
  nativePictureInPicture,
  onNativePictureInPicture,
}: Props) {
  if (!previewBridge) return null;
  const bridge = previewBridge;
  const tabDisabled = !tabId || !hasWebContents;
  const callTab = (op: (tabId: string) => Promise<void>) => () => {
    if (!tabId) return;
    void op(tabId).catch(() => undefined);
  };

  const zoomLabel = `${Math.round(zoomFactor * 100)} %`;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" type="button" aria-label="Vorschaumenü" />
              }
            />
          }
        >
          <MoreVertical />
        </TooltipTrigger>
        <TooltipPopup>Mehr</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="min-w-56">
        <MenuItem onClick={callTab(bridge.hardReload)} disabled={tabDisabled}>
          Neu laden
        </MenuItem>
        <MenuItem onClick={callTab(bridge.openDevTools)} disabled={tabDisabled}>
          DevTools öffnen
        </MenuItem>
        <MenuItem onClick={onNativePictureInPicture} disabled={tabDisabled}>
          {nativePictureInPicture ? "Eigenes Fenster schließen" : "In eigenem Fenster"}
        </MenuItem>
        <MenuItem onClick={onToggleDeviceToolbar} disabled={tabDisabled}>
          {deviceToolbarVisible ? "Geräteleiste ausblenden" : "Geräteleiste einblenden"}
        </MenuItem>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Darstellung</MenuGroupLabel>
          <MenuRadioGroup
            value={colorScheme}
            onValueChange={(value) => {
              if (!tabId) return;
              void bridge
                .setColorScheme(tabId, value as DesktopPreviewColorScheme)
                .catch(() => undefined);
            }}
          >
            {COLOR_SCHEME_OPTIONS.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} disabled={tabDisabled}>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Zoom {zoomLabel}</MenuGroupLabel>
          <MenuItem closeOnClick={false} onClick={callTab(bridge.zoomIn)} disabled={tabDisabled}>
            Vergrößern
          </MenuItem>
          <MenuItem closeOnClick={false} onClick={callTab(bridge.zoomOut)} disabled={tabDisabled}>
            Verkleinern
          </MenuItem>
          <MenuItem closeOnClick={false} onClick={callTab(bridge.resetZoom)} disabled={tabDisabled}>
            Zoom zurücksetzen
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => void bridge.clearCookies().catch(() => undefined)}>
          Cookies löschen
        </MenuItem>
        <MenuItem onClick={() => void bridge.clearCache().catch(() => undefined)}>
          Cache leeren
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
