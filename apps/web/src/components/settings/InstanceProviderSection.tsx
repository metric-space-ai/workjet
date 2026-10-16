import type { InstanceGrokAccountPresentation } from "./WorkjetModelsProviders";
import type { useInstanceProviders } from "./useInstanceProviders";
import { NativeProviderRowsView } from "./NativeProviderRows";
import { Button } from "../ui/button";
import { ensureLocalApi } from "../../localApi";
import {
  describeWorkjetProjectControlFailure,
  isCoreOutdatedFailure,
  workjetUiLanguage,
  type WorkjetProjectControlFailure,
} from "../../workjetProjectControl";

/** Where an Owner applies a new CTOX core to a managed instance. */
const CTOX_CORE_APPLY_URL = "https://ctox.dev/";

export function InstanceConnectionStatus({
  label,
  failure,
  busy,
  reconnect,
}: {
  readonly label: string;
  readonly failure: WorkjetProjectControlFailure;
  readonly busy: boolean;
  readonly reconnect: () => void;
}) {
  // One status line plus one button (UI-Vertrag §1 Banner). The preparation
  // stage, error codes and HTTP status are raw diagnostics and belong on the
  // Diagnose page, not in an expandable "Grund" block here.
  const en = workjetUiLanguage() === "en";
  if (isCoreOutdatedFailure(failure)) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground"
        data-workjet-instance-connection="core-outdated"
      >
        <span className="min-w-0">
          {en
            ? `${label}: core outdated. Apply the current CTOX core on the instance, then reload.`
            : `${label}: Core veraltet. Den aktuellen CTOX-Core auf der Instanz anwenden, dann neu laden.`}
        </span>
        <Button
          size="xs"
          variant="outline"
          onClick={() => void ensureLocalApi().shell.openExternal(CTOX_CORE_APPLY_URL)}
        >
          {en ? "Apply core" : "Core anwenden"}
        </Button>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground"
      data-workjet-instance-connection=""
    >
      <span className="min-w-0">{describeWorkjetProjectControlFailure(failure, null, "de")}</span>
      <Button size="xs" variant="outline" disabled={busy} onClick={reconnect}>
        {en ? "Reconnect" : "Neu verbinden"}
      </Button>
    </div>
  );
}

/**
 * Nur Fehler, die der Nutzer selbst beheben kann (Core anwenden, anmelden),
 * bekommen eine Zeile. Alles andere wird still wiederholt, und die zuletzt
 * bekannten Konten bleiben stehen (Owner-Regel: keine Zustandssätze).
 */
export function isActionableInstanceFailure(failure: WorkjetProjectControlFailure): boolean {
  return isCoreOutdatedFailure(failure) || failure.code === "authentication_required";
}

/** Ob unter „Instanz …“ mindestens eine Zeile steht (Laden zählt als Zeile). */
export function instanceProviderSectionHasRows(input: {
  readonly failure: WorkjetProjectControlFailure | undefined;
  readonly unsupportedProviders: WorkjetProjectControlFailure | undefined;
  readonly grok: Pick<InstanceGrokAccountPresentation, "row">;
  readonly providers: Pick<
    ReturnType<typeof useInstanceProviders>,
    "registry" | "connectionFailure"
  >;
}): boolean {
  if (input.failure || input.unsupportedProviders) return true;
  if (input.grok.row !== null && input.grok.row !== undefined && input.grok.row !== false)
    return true;
  const registry = input.providers.registry;
  if (!registry) return !input.providers.connectionFailure;
  return registry.accounts.length > 0;
}

export function InstanceProviderSection({
  label,
  grok,
  providers,
}: {
  readonly label: string;
  readonly grok: InstanceGrokAccountPresentation;
  readonly providers: ReturnType<typeof useInstanceProviders>;
}) {
  // Grok has its own admitted control channel. An older instance can support
  // that login while its general account-management channel is unavailable.
  const unsupportedProviders =
    providers.connectionFailure?.code === "unsupported" ? providers.connectionFailure : undefined;
  const failure = [
    unsupportedProviders ? undefined : providers.connectionFailure,
    grok.connectionFailure,
  ].find((candidate) => candidate !== undefined && isActionableInstanceFailure(candidate));
  // Ohne eine einzige Zeile fällt auch die Überschrift weg (N5).
  if (!instanceProviderSectionHasRows({ failure, unsupportedProviders, grok, providers }))
    return null;
  return (
    <div role="rowgroup" aria-label={`Instanz ${label}`}>
      <div className="bg-muted/30 px-3 py-1.5 text-xs font-semibold text-muted-foreground">
        Instanz {label}
      </div>
      {failure ? (
        <InstanceConnectionStatus
          label={label}
          failure={failure}
          busy={providers.busy || grok.checking}
          reconnect={() => {
            void providers.run({ action: "instance.providers.read" });
            grok.refresh();
          }}
        />
      ) : (
        <>
          {grok.row}
          {unsupportedProviders ? (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground"
              data-workjet-provider-management-unavailable=""
            >
              <span>{describeWorkjetProjectControlFailure(unsupportedProviders, null, "de")}</span>
              <Button
                size="xs"
                variant="outline"
                disabled={providers.busy}
                onClick={() => {
                  void providers.run({ action: "instance.providers.read" });
                }}
              >
                Konten neu laden
              </Button>
            </div>
          ) : (
            <NativeProviderRowsView label={label} state={providers} />
          )}
        </>
      )}
    </div>
  );
}
