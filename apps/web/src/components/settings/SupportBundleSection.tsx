import type { DesktopSupportBundleResult } from "@workjet/contracts";
import { AlertTriangleIcon, CopyIcon, LifeBuoyIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsSection } from "./settingsLayout";

/**
 * The user-facing entry point for the redacted support bundle.
 *
 * Two things this section must do, and one it must never do:
 *
 *  - It has to SAY WHAT LEAVES, before the user clicks. The bundle is a file
 *    they will hand to someone else, so the copy names what is inside and
 *    what has been removed rather than hiding it behind "diagnostics".
 *  - It has to SHOW THE EXACT PATH afterwards, selectable and copyable. A
 *    bundle the user cannot open is a bundle they cannot check.
 *  - It must never offer to send anything. There is no upload affordance
 *    here, and no bridge method behind one: the desktop deliberately exposes
 *    `createSupportBundle` and nothing else.
 */
export interface SupportBundleState {
  readonly status: "idle" | "creating" | "created" | "failed";
  readonly result: DesktopSupportBundleResult | null;
  readonly errorMessage: string | null;
}

export const INITIAL_SUPPORT_BUNDLE_STATE: SupportBundleState = {
  status: "idle",
  result: null,
  errorMessage: null,
};

/** Shown when the renderer is not hosted by a desktop build that has the bridge. */
export const SUPPORT_BUNDLE_UNAVAILABLE_MESSAGE = "Nur in der Desktop-App";

export function formatSupportBundleSize(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`;
  const kilobytes = byteLength / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(kilobytes >= 10 ? 0 : 1).replace(".", ",")} KB`;
  return `${(kilobytes / 1024).toFixed(1).replace(".", ",")} MB`;
}

/**
 * The one-line receipt under the path. It reports what the gate withheld,
 * because a bundle that hid twenty fields and says so is trustworthy and one
 * that hid them silently is not.
 */
export function describeSupportBundleRedaction(result: DesktopSupportBundleResult): string {
  return `${formatSupportBundleSize(result.byteLength)} · ${result.fieldCount} Felder · ${result.redactedFieldCount} geschwärzt · ${result.omittedFieldCount} ausgelassen`;
}

export function SupportBundleSectionView({
  state,
  isAvailable,
  isPathCopied,
  onCreate,
  onCopyPath,
}: {
  state: SupportBundleState;
  isAvailable: boolean;
  isPathCopied: boolean;
  onCreate: () => void;
  onCopyPath: () => void;
}) {
  return (
    <SettingsSection
      id="support-bundle"
      title="Support-Bundle"
      icon={<LifeBuoyIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                disabled={!isAvailable || state.status === "creating"}
                onClick={onCreate}
              >
                {state.status === "creating" ? "Erstellt …" : "Erstellen"}
              </Button>
            }
          />
          <TooltipPopup side="top">Datei bleibt auf diesem Rechner</TooltipPopup>
        </Tooltip>
      }
    >
      {!isAvailable ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          {SUPPORT_BUNDLE_UNAVAILABLE_MESSAGE}
        </p>
      ) : null}

      {state.status === "created" && state.result ? (
        <div className="space-y-1 px-3 text-xs text-muted-foreground sm:px-4">
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground">
              {state.result.filePath}
            </code>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={isPathCopied ? "Pfad kopiert" : "Pfad kopieren"}
                    onClick={onCopyPath}
                  >
                    <CopyIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">{isPathCopied ? "Kopiert" : "Pfad kopieren"}</TooltipPopup>
            </Tooltip>
          </div>
          <p className="font-mono text-[11px] tabular-nums">
            {describeSupportBundleRedaction(state.result)}
          </p>
        </div>
      ) : null}

      {state.status === "failed" && state.errorMessage ? (
        <div className="flex items-start gap-2 px-3 text-destructive text-xs sm:px-4" role="alert">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{state.errorMessage}</span>
        </div>
      ) : null}
    </SettingsSection>
  );
}

export function SupportBundleSection() {
  const createSupportBundle = window.desktopBridge?.createSupportBundle;
  const [state, setState] = useState<SupportBundleState>(INITIAL_SUPPORT_BUNDLE_STATE);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "bundle path",
    timeout: 1_200,
  });

  const onCreate = useCallback(() => {
    if (!createSupportBundle) return;
    setState({ status: "creating", result: null, errorMessage: null });
    void (async () => {
      try {
        const result = await createSupportBundle();
        setState({ status: "created", result, errorMessage: null });
      } catch (error) {
        setState({
          status: "failed",
          result: null,
          errorMessage: error instanceof Error ? error.message : "Nicht erstellt",
        });
      }
    })();
  }, [createSupportBundle]);

  const onCopyPath = useCallback(() => {
    if (state.result) copyToClipboard(state.result.filePath);
  }, [copyToClipboard, state.result]);

  return (
    <SupportBundleSectionView
      state={state}
      isAvailable={createSupportBundle !== undefined}
      isPathCopied={isCopied}
      onCreate={onCreate}
      onCopyPath={onCopyPath}
    />
  );
}
