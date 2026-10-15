import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { WorkjetInstanceGrokResponse, WorkjetNativeProviderAccount } from "@workjet/contracts";
import {
  requestInstanceGrok,
  grokVerificationLink,
  type InstanceGrokInput,
} from "../../lib/workjetInstanceGrok";
import type { InstanceGrokAccountPresentation } from "./WorkjetModelsProviders";
import {
  WorkjetProjectControlError,
  type WorkjetProjectControlFailure,
} from "../../workjetProjectControl";
import { WORKJET_GATEWAY_PROVIDER_ICONS } from "./WorkjetGatewayAccounts";
import { Button } from "../ui/button";
import { Row, RowStatusDot, type RowStatus } from "../ui/row";
import { NativeProviderLimits } from "./NativeProviderLimits";
import { SettingsLoadingRow } from "./settingsAdd";

type Check = NonNullable<WorkjetInstanceGrokResponse["check"]>;
type GrokFailure = {
  readonly errorCode: Check["errorCode"];
  readonly upstream?: Check["upstream"] | undefined;
};
const INSTANCE_RETRY_MS = 15_000;

/** Eine Fehlerzeile mit höchstens 12 Wörtern (UI-Vertrag §2), Deutsch. */
export function grokFailureLine(failure: GrokFailure): string {
  const status = failure.upstream?.status;
  if (status === 401) return "Anmeldung abgelaufen. Abo entfernen und neu anmelden.";
  if (status === 403) return "Zugriff verweigert. Abo-Berechtigung prüfen.";
  if (status === 404) return "Modell beim Anbieter nicht gefunden.";
  if (status === 426) return "Instanz zu alt für Grok. CTOX aktualisieren.";
  if (status === 429) return "Anbieter drosselt. Später erneut versuchen.";
  if (status !== undefined) return `Anbieter antwortet mit HTTP ${status}.`;
  switch (failure.errorCode) {
    case "timeout":
      return "Keine Antwort in 20 Sekunden.";
    case "missing_credential":
      return "Nicht angemeldet.";
    case "model_unavailable":
      return "Modell fehlt im Abo.";
    case "invalid_response":
      return "Antwort unbrauchbar.";
    default:
      return "Prüfung fehlgeschlagen.";
  }
}

function grokRowStatus(
  busy: string | undefined,
  checks: Readonly<Record<string, Check>>,
  problem: boolean,
): RowStatus {
  const results = Object.values(checks).map((check) => check.status);
  if (busy !== undefined && !busy.startsWith("instance.grok.")) return "busy";
  if (problem || results.includes("error")) return "error";
  return results.includes("ok") ? "ok" : "off";
}

/**
 * Instance-owned subscription. It renders in the same `ui/row` list as the
 * accounts of this computer (Audit C 1–3); its quota comes from the instance's
 * provider registry when the instance reports one.
 */
export function useInstanceGrokAccount(
  instanceId: string,
  label: string,
  quota?: WorkjetNativeProviderAccount["reportedQuota"],
): InstanceGrokAccountPresentation {
  const [state, setState] = useState<WorkjetInstanceGrokResponse>();
  const [checks, setChecks] = useState<Readonly<Record<string, Check>>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [connectionFailure, setConnectionFailure] = useState<WorkjetProjectControlFailure>();
  /** Eine vom Nutzer ausgelöste Aktion endet nie still (Audit C 47). */
  const [userFailure, setUserFailure] = useState(false);
  const lastInput = useRef<InstanceGrokInput | undefined>(undefined);
  const alive = useRef(true);
  const controller = useRef<AbortController | undefined>(undefined);
  const retained = useRef<WorkjetInstanceGrokResponse | undefined>(undefined);
  /** Rohcode des letzten Fehlers, nur für „Details“. */
  const lastFailure = useRef<string | null>(null);
  const apply = useCallback((result: WorkjetInstanceGrokResponse) => {
    retained.current = result;
    setState(result);
    const check = result.check;
    if (
      !result.installed ||
      result.action === "instance.grok.read" ||
      result.action === "instance.grok.remove"
    ) {
      setChecks(check && result.installed ? { [check.modelId]: check } : {});
    } else if (check) setChecks((old) => ({ ...old, [check.modelId]: check }));
  }, []);
  const run = useCallback(
    async (input: InstanceGrokInput, user = false) => {
      if (!alive.current) return undefined;
      if (user) {
        lastInput.current = input;
        setUserFailure(false);
      }
      controller.current?.abort();
      const active = new AbortController();
      controller.current = active;
      setBusy(input.action === "instance.grok.check" ? input.modelId : input.action);
      setError(undefined);
      lastFailure.current = null;
      try {
        const result = await requestInstanceGrok(instanceId, input, active.signal);
        if (active.signal.aborted || !alive.current) return undefined;
        setConnectionFailure(undefined);
        setUserFailure(false);
        apply(result);
        return result;
      } catch (failure) {
        lastFailure.current =
          failure instanceof WorkjetProjectControlError
            ? failure.failure.code
            : failure instanceof Error
              ? failure.message
              : "unknown";
        if (!active.signal.aborted && alive.current) {
          if (failure instanceof WorkjetProjectControlError) {
            setConnectionFailure(failure.failure);
            if (user) setUserFailure(true);
          } else setError("Grok-Aktion fehlgeschlagen.");
        }
        return undefined;
      } finally {
        if (controller.current === active && !active.signal.aborted) setBusy(undefined);
      }
    },
    [instanceId, apply],
  );

  useEffect(() => {
    alive.current = true;
    void run({ action: "instance.grok.read" });
    return () => {
      alive.current = false;
      controller.current?.abort();
      const login = retained.current?.login;
      if (login?.phase === "pending") {
        const cancel = new AbortController();
        void requestInstanceGrok(
          instanceId,
          { action: "instance.grok.cancel", loginId: login.loginId },
          cancel.signal,
        ).catch(() => {});
      }
    };
  }, [instanceId, run]);

  const loginId = state?.login?.loginId;
  const phase = state?.login?.phase;
  const expiresAt = state?.login?.expiresAt;
  useEffect(() => {
    if (!loginId || phase !== "pending" || expiresAt === undefined) return;
    const active = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await requestInstanceGrok(
          instanceId,
          { action: "instance.grok.poll", loginId },
          active.signal,
        );
        if (active.signal.aborted) return;
        apply(result);
        if (result.login?.phase === "pending") {
          if (Date.now() >= expiresAt) {
            setError("Anmeldecode abgelaufen. Neu anmelden.");
            void run({ action: "instance.grok.cancel", loginId });
          } else
            timer = setTimeout(() => {
              void poll();
            }, 2000);
        } else if (result.login?.phase === "accepted" && result.installed) {
          setChecks({});
          // This required model was observed in real provider discovery. The
          // instance must independently advertise it before any request is sent.
          if (result.models.includes("grok-4.7"))
            void run({ action: "instance.grok.check", modelId: "grok-4.7" });
          else setError("Angemeldet, aber grok-4.7 fehlt im Abo. Modelle neu laden.");
        } else if (result.login?.phase === "failed" || result.login?.phase === "expired") {
          setError("Anmeldung nicht abgeschlossen. Neu anmelden.");
        }
      } catch {
        if (!active.signal.aborted) setError("Anmeldung nicht verfolgbar. Konto neu laden.");
      }
    };
    timer = setTimeout(() => {
      void poll();
    }, 2000);
    return () => {
      active.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [instanceId, loginId, phase, expiresAt, apply, run]);

  const checkAll = () => {
    void (async () => {
      for (const modelId of state?.models ?? []) {
        const result = await run({ action: "instance.grok.check", modelId }, true);
        if (!result) break;
      }
    })();
  };
  // Ein Verbindungsfehler wird still wiederholt; die letzte bekannte Zeile bleibt stehen.
  useEffect(() => {
    if (!connectionFailure || busy !== undefined) return;
    const timer = setTimeout(() => {
      void run({ action: "instance.grok.read" });
    }, INSTANCE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [connectionFailure, busy, run]);

  /** Startet das Abo auf der Instanz; liefert den Rohcode eines Fehlers oder null. */
  const start = async (): Promise<string | null> => {
    const result = await run({ action: "instance.grok.start" }, true);
    if (!result) return lastFailure.current ?? "unknown";
    if (
      result.login?.phase === "accepted" &&
      result.installed &&
      result.models.includes("grok-4.7")
    ) {
      setChecks({});
      void run({ action: "instance.grok.check", modelId: "grok-4.7" });
    }
    return null;
  };
  const Icon = WORKJET_GATEWAY_PROVIDER_ICONS.xai;
  const login = state?.login;
  const link = login && grokVerificationLink(login.verificationUri);
  const lastProblem =
    state?.catalogError ?? (state?.check?.status === "error" ? state.check : null);
  const pending = phase === "pending" && login;
  const failureLine = userFailure
    ? "Instanz antwortet nicht."
    : (error ?? (lastProblem ? grokFailureLine(lastProblem) : null));
  const retry = () => {
    const input = lastInput.current;
    void run(input ?? { action: "instance.grok.read" }, input !== undefined);
  };
  const statusLine = failureLine ? (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-9 text-xs text-destructive"
      data-workjet-instance-grok-failure=""
    >
      <span>{failureLine}</span>
      <Button size="xs" variant="outline" disabled={!!busy} onClick={retry}>
        Erneut versuchen
      </Button>
    </div>
  ) : null;
  const pendingLine = pending ? (
    <div role="status" className="flex flex-wrap items-center gap-3 px-3 pb-2 pl-9 text-xs">
      <span>
        Code <strong className="font-mono select-all">{login.userCode}</strong>
      </span>
      {link ? (
        <Button
          size="xs"
          render={
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              data-workjet-action="models.instance.xai.open-login"
            />
          }
        >
          Anmeldung öffnen
        </Button>
      ) : (
        <span role="alert">Anmeldelink ungültig.</span>
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={!!busy}
        onClick={() => {
          void run({ action: "instance.grok.cancel", loginId: login.loginId }, true);
        }}
      >
        Abbrechen
      </Button>
    </div>
  ) : null;
  // Ohne Abo gibt es keine Zeile: hinzugefügt wird über „+ Hinzufügen › xAI“
  // (Audit C 4, 46). Vor der ersten Antwort ein Skelett, nach 10 s
  // „Nicht erreichbar · Erneut“ (Audit C 5).
  let row: ReactNode;
  if (state === undefined) {
    row = (
      <div data-account-id="ctox-instance-grok">
        {userFailure ? statusLine : <SettingsLoadingRow onRetry={retry} label="Grok lädt" />}
      </div>
    );
  } else if (!state.installed) {
    row =
      pendingLine || statusLine ? (
        <div data-account-id="ctox-instance-grok">
          {pendingLine}
          {statusLine}
        </div>
      ) : null;
  } else {
    const rowStatus = grokRowStatus(busy, checks, Boolean(lastProblem || userFailure));
    row = (
      <div data-account-id="ctox-instance-grok">
        <Row
          className="py-1.5"
          status={rowStatus}
          statusLabel={
            rowStatus === "ok"
              ? "Prüfung bestanden"
              : rowStatus === "error"
                ? "Prüfung fehlgeschlagen"
                : rowStatus === "busy"
                  ? "Prüft"
                  : "Nicht geprüft"
          }
          name={
            <span className="flex min-w-0 items-center gap-2">
              <Icon role="img" aria-label="xAI" className="size-4 shrink-0" />
              <span className="truncate">{state.accountLabel}</span>
            </span>
          }
          meta={<span className="pl-6">Abo · Instanz {label}</span>}
          chips={
            quota === undefined ? undefined : <NativeProviderLimits provider="xai" quota={quota} />
          }
          onDelete={() => {
            void run({ action: "instance.grok.remove" }, true);
          }}
          deleteLabel="Entfernen"
          deleteConfirmTitle="Abo entfernen?"
          menuActions={[
            { label: "Neu prüfen", onSelect: checkAll },
            {
              label: "Neu laden",
              onSelect: () => {
                void run({ action: "instance.grok.read" }, true);
              },
            },
          ]}
          menuLabel={`Aktionen für ${state.accountLabel}`}
        />
        {state.models.length > 0 ? (
          <div className="flex min-w-0 flex-wrap gap-1 px-3 pb-1.5 pl-9">
            {state.models.map((modelId) => {
              const check = checks[modelId];
              const running = busy === modelId;
              const status: RowStatus = running
                ? "busy"
                : check?.status === "ok"
                  ? "ok"
                  : check?.status === "error"
                    ? "error"
                    : "off";
              return (
                <Button
                  key={modelId}
                  size="xs"
                  variant="outline"
                  className="font-mono"
                  disabled={!!busy || phase === "pending"}
                  onClick={() => {
                    void run({ action: "instance.grok.check", modelId }, true);
                  }}
                  data-workjet-action={`models.instance.xai.check.${modelId}`}
                  title={
                    running
                      ? "Prüft …"
                      : check?.status === "ok"
                        ? `Prüfung bestanden${check.latencyMs === null ? "" : ` · ${check.latencyMs} ms`} · ${new Date(check.checkedAt).toLocaleString("de-DE")}`
                        : check?.status === "error"
                          ? grokFailureLine(check)
                          : "Nicht geprüft"
                  }
                >
                  <RowStatusDot
                    status={status}
                    label={
                      running
                        ? "Prüft"
                        : check?.status === "ok"
                          ? "Prüfung bestanden"
                          : check?.status === "error"
                            ? "Prüfung fehlgeschlagen"
                            : "Nicht geprüft"
                    }
                  />
                  {modelId}
                </Button>
              );
            })}
          </div>
        ) : null}
        {pendingLine}
        {statusLine}
      </div>
    );
  }
  return {
    row,
    connectionFailure,
    label,
    installed: state?.installed ?? false,
    hasModels: !!state?.models.length,
    // Nur echte Modellprüfungen; stilles Neuladen ist kein „Prüft“.
    checking: busy !== undefined && !busy.startsWith("instance.grok."),
    start,
    checkAll,
    refresh: () => {
      void run({ action: "instance.grok.read" });
    },
  };
}
