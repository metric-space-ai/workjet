import type { InstanceGrokAccountPresentation } from "./WorkjetModelsProviders";
import type { useInstanceProviders } from "./useInstanceProviders";
import { NativeProviderRowsView } from "./NativeProviderRows";
import { Button } from "../ui/button";
import {
  describeGuestPreparationStage,
  describeGuestPreparationReason,
  describeWorkjetProjectControlFailure,
  workjetUiLanguage,
  type WorkjetProjectControlFailure,
} from "../../workjetProjectControl";

export function InstanceConnectionStatus({
  label,
  failure,
  busy,
  reconnect,
  language = workjetUiLanguage(),
}: {
  readonly label: string;
  readonly failure: WorkjetProjectControlFailure;
  readonly busy: boolean;
  readonly reconnect: () => void;
  readonly language?: "de" | "en";
}) {
  const de = language === "de";
  const diagnostic = failure.preparation;
  return (
    <div
      role="status"
      className="space-y-1 py-2 text-xs text-muted-foreground"
      data-workjet-instance-connection=""
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {de
            ? `Verbindung zur Instanz ${label} gestört – Konten der Instanz werden nicht geladen.`
            : `Connection to instance ${label} interrupted – instance accounts cannot be loaded.`}
        </span>
        <Button size="xs" variant="ghost" disabled={busy} onClick={reconnect}>
          {de ? "Neu verbinden" : "Reconnect"}
        </Button>
      </div>
      <details>
        <summary className="cursor-pointer">{de ? "Grund" : "Reason"}</summary>
        <p className="py-1">{describeWorkjetProjectControlFailure(failure, null, language)}</p>
        {diagnostic && (
          <div>
            <p>{describeGuestPreparationReason(diagnostic, language)}</p>
            <p data-workjet-diagnostic-stage={diagnostic.stage}>
              {de ? "Stufe" : "Stage"}: {describeGuestPreparationStage(diagnostic.stage, language)}{" "}
              ({diagnostic.stage})
              {diagnostic.errorCode !== undefined ? ` · Electron ${diagnostic.errorCode}` : ""}
              {diagnostic.httpStatus !== undefined ? ` · HTTP ${diagnostic.httpStatus}` : ""}
            </p>
          </div>
        )}
      </details>
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
  const language = workjetUiLanguage();
  const failure =
    providers.connectionFailure ??
    grok.connectionFailure ??
    (providers.error && !providers.errorAccountId
      ? { _tag: "failed" as const, code: "guest_failed" as const }
      : undefined);
  return (
    <div
      role="rowgroup"
      aria-label={`${language === "de" ? "Instanz" : "Instance"} ${label}`}
      className="border-b border-border"
    >
      <div className="py-2 text-xs font-semibold">
        {language === "de" ? "Instanz" : "Instance"} {label}
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
          <NativeProviderRowsView label={label} state={providers} />
        </>
      )}
    </div>
  );
}
