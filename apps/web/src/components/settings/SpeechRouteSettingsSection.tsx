import { type WorkjetSpeechRoute } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { type SpeechComputerOption } from "../../lib/speechRoutes";
import { useEnvironments } from "../../state/environments";
import { SpeechRouteSettings } from "../SpeechRouteSettings";

/**
 * Settings section "Sprache". Routes are stored on the primary environment.
 * Per-computer speech capability is not reported yet, so every computer is
 * listed as unknown until the server confirms it.
 */
export function SpeechRouteSettingsSection() {
  const { environments } = useEnvironments();
  const [routes, setRoutes] = useState<ReadonlyArray<WorkjetSpeechRoute>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    runPrimaryHttp(
      Effect.gen(function* () {
        const client = yield* PrimaryEnvironmentHttpClient;
        return yield* client.speechRoutes.listSpeechRoutes({ headers: {} });
      }),
    )
      .then((result) => {
        if (!cancelled) setRoutes(result.routes);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Die Sprachrouten konnten nicht geladen werden.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const computers = useMemo<ReadonlyArray<SpeechComputerOption>>(
    () =>
      environments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        capability: { stt: "unknown", tts: "unknown" },
      })),
    [environments],
  );

  const handleChange = useCallback((route: WorkjetSpeechRoute) => {
    setSaving(true);
    setSaveError(null);
    runPrimaryHttp(
      Effect.gen(function* () {
        const client = yield* PrimaryEnvironmentHttpClient;
        return yield* client.speechRoutes.setSpeechRoute({ headers: {}, payload: route });
      }),
    )
      .then((saved) => {
        setRoutes((current) => [
          ...current.filter((existing) => existing.sessionKind !== saved.sessionKind),
          saved,
        ]);
      })
      .catch(() => {
        setSaveError("Die Auswahl konnte nicht gespeichert werden. Bitte versuche es erneut.");
      })
      .finally(() => setSaving(false));
  }, []);

  return (
    <section className="mt-8 space-y-4 border-t border-border pt-6">
      <h2 className="text-sm font-semibold text-foreground">Sprache</h2>
      <p className="text-xs text-muted-foreground">
        Lege fest, welcher Computer die Spracherkennung und die Sprachausgabe für den Regeltermin
        und für spontane Sprachsitzungen übernimmt. Ein Computer, der die Richtung nicht bestätigt,
        lässt die Sitzung scheitern. Auf einen anderen Computer wechselt sie nicht.
      </p>
      {loadError ? (
        <p role="alert" className="text-xs text-destructive">
          {loadError}
        </p>
      ) : null}
      {saveError ? (
        <p role="alert" className="text-xs text-destructive">
          {saveError}
        </p>
      ) : null}
      <SpeechRouteSettings
        routes={routes}
        computers={computers}
        disabled={saving || loadError !== null}
        onChange={handleChange}
      />
    </section>
  );
}
