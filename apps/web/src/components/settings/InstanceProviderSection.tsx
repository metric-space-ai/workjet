import type { InstanceGrokAccountPresentation } from "./WorkjetModelsProviders";
import type { useInstanceProviders } from "./useInstanceProviders";
import { NativeProviderRowsView } from "./NativeProviderRows";
import { Button } from "../ui/button";
import {
  describeWorkjetProjectControlFailure,
  type WorkjetProjectControlFailure,
} from "../../workjetProjectControl";

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
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs text-muted-foreground"
      data-workjet-instance-connection=""
    >
      <span className="min-w-0">
        Instanz {label} nicht verbunden ·{" "}
        {describeWorkjetProjectControlFailure(failure, null, "de")}
      </span>
      <Button size="xs" variant="outline" disabled={busy} onClick={reconnect}>
        Neu verbinden
      </Button>
    </div>
  );
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
  const failure =
    (unsupportedProviders ? undefined : providers.connectionFailure) ??
    grok.connectionFailure ??
    (!unsupportedProviders && providers.error && !providers.errorAccountId
      ? { _tag: "failed" as const, code: "guest_failed" as const }
      : undefined);
  return (
    <div role="rowgroup" aria-label={`Instanz ${label}`} className="border-b border-border">
      <div className="py-2 text-xs font-semibold">Instanz {label}</div>
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
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs text-muted-foreground"
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
