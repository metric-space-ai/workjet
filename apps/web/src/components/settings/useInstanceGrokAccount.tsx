import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  CircleDashedIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import type { WorkjetInstanceGrokResponse } from "@workjet/contracts";
import {
  requestInstanceGrok,
  grokVerificationLink,
  describeInstanceGrokFailure,
  type InstanceGrokInput,
} from "../../lib/workjetInstanceGrok";
import type { InstanceGrokAccountPresentation } from "./WorkjetModelsProviders";
import {
  WorkjetProjectControlError,
  type WorkjetProjectControlFailure,
} from "../../workjetProjectControl";
import { WORKJET_GATEWAY_PROVIDER_ICONS } from "./WorkjetGatewayAccounts";
import { Button } from "../ui/button";

type Check = NonNullable<WorkjetInstanceGrokResponse["check"]>;
const INSTANCE_RETRY_MS = 15_000;
const columns =
  "grid grid-cols-[minmax(9rem,1.15fr)_minmax(0,2fr)_minmax(6rem,.7fr)_2rem_4rem] items-center gap-x-3";

/** Instance-owned subscription; computer gateway accounts remain separate rows. */
export function useInstanceGrokAccount(
  instanceId: string,
  label: string,
): InstanceGrokAccountPresentation {
  const [state, setState] = useState<WorkjetInstanceGrokResponse>();
  const [checks, setChecks] = useState<Readonly<Record<string, Check>>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [connectionFailure, setConnectionFailure] = useState<WorkjetProjectControlFailure>();
  const [confirmRemove, setConfirmRemove] = useState(false);
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
    async (input: InstanceGrokInput) => {
      if (!alive.current) return undefined;
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
          if (failure instanceof WorkjetProjectControlError) setConnectionFailure(failure.failure);
          else setError(failure instanceof Error ? failure.message : "Grok-Aktion fehlgeschlagen.");
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
        const result = await run({ action: "instance.grok.check", modelId });
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
    setConfirmRemove(false);
    const result = await run({ action: "instance.grok.start" });
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
  const row = (
    <div role="rowgroup" data-account-id="ctox-instance-grok" className="border-b border-border/50">
      <div role="row" className={columns + " min-h-14 py-1.5"}>
        <div role="cell" className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <Icon className="size-4 shrink-0" />
            <span>xAI · Grok Build</span>
            {!state?.installed && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Grok-Konto auf ${label} hinzufügen`}
                data-workjet-action="models.instance.xai.add-account"
                disabled={!!busy || phase === "pending"}
                onClick={() => void start()}
              >
                <PlusIcon className="size-3" />
              </Button>
            )}
          </div>
          <span className="block break-words text-[11px] text-muted-foreground">
            {label} ·{" "}
            {state ? (state.installed ? state.accountLabel : "OAuth-Abo") : "—"}
          </span>
        </div>
        <div role="cell" className="flex min-w-0 flex-wrap gap-1">
          {state?.models.map((modelId) => {
            const check = checks[modelId];
            const running = busy === modelId;
            const Status =
              running || !check ? CircleDashedIcon : check.status === "ok" ? CheckIcon : XIcon;
            return (
              <button
                key={modelId}
                type="button"
                className="inline-flex min-w-0 items-center gap-1 rounded border border-border px-1.5 py-1 font-mono text-[11px]"
                disabled={!!busy || phase === "pending"}
                onClick={() => {
                  void run({ action: "instance.grok.check", modelId });
                }}
                data-workjet-action={`models.instance.xai.check.${modelId}`}
                title={
                  running
                    ? "Prüft …"
                    : check?.status === "ok"
                      ? `Prüfung bestanden · ${check.latencyMs} ms · ${new Date(check.checkedAt).toLocaleString("de-DE")}`
                      : check?.status === "error"
                        ? describeInstanceGrokFailure(check)
                        : "Nicht geprüft"
                }
              >
                <span className="min-w-0 whitespace-normal break-all">{modelId}</span>
                <Status
                  className={
                    "size-3 shrink-0 " +
                    (running || !check
                      ? "text-muted-foreground"
                      : check.status === "ok"
                        ? "text-emerald-500"
                        : "text-destructive")
                  }
                  aria-label={
                    running
                      ? "Prüft"
                      : check?.status === "ok"
                        ? "Prüfung bestanden"
                        : check?.status === "error"
                          ? (check.errorCode ?? "Prüfung fehlgeschlagen")
                          : "Nicht geprüft"
                  }
                />
              </button>
            );
          })}
          {state?.installed && state.models.length === 0 && (
            <span className="text-xs text-muted-foreground">Keine Modelle gemeldet</span>
          )}
          {!state?.installed && phase !== "pending" && (
            <Button
              size="xs"
              variant="outline"
              disabled={!!busy}
              data-workjet-action="models.instance.xai.sign-in"
              onClick={() => void start()}
            >
              Grok Build OAuth
            </Button>
          )}
        </div>
        <span role="cell" title="Keine Limits gemeldet" className="text-xs text-muted-foreground">
          —
        </span>
        <span
          role="cell"
          title={
            state
              ? state.installed
                ? "Abo gespeichert"
                : "Kein Abo gespeichert"
              : "Kontostatus nicht verfügbar"
          }
          aria-label={state ? undefined : "Kontostatus nicht verfügbar"}
          className="text-center text-xs text-muted-foreground"
        >
          {state ? (state.installed ? "✓" : "—") : "◌"}
        </span>
        <div role="cell">
          {state?.installed ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Grok-Konto von ${label} entfernen`}
              disabled={!!busy}
              onClick={() => setConfirmRemove(true)}
              data-workjet-action="models.instance.xai.remove"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Grok-Konto neu laden"
              disabled={!!busy}
              onClick={() => {
                void run({ action: "instance.grok.read" });
              }}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {phase === "pending" && login && (
        <div role="status" className="flex flex-wrap items-center gap-3 py-2 text-xs">
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
              Grok-Anmeldung öffnen
            </Button>
          ) : (
            <span role="alert">Anmeldelink ungültig. Abbrechen und neu starten.</span>
          )}
          <Button
            size="xs"
            variant="outline"
            disabled={!!busy}
            onClick={() => {
              void run({ action: "instance.grok.cancel", loginId: login.loginId });
            }}
          >
            Anmeldung abbrechen
          </Button>
        </div>
      )}
      {confirmRemove && (
        <div role="alert" className="flex flex-wrap items-center gap-2 py-2 text-xs">
          <span>Abo von {label} entfernen?</span>
          <Button
            size="xs"
            variant="destructive"
            disabled={!!busy}
            data-workjet-action="models.instance.xai.confirm-remove"
            onClick={() => {
              void run({ action: "instance.grok.remove" }).then((result) => {
                if (result) setConfirmRemove(false);
              });
            }}
          >
            Entfernen
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!!busy}
            onClick={() => setConfirmRemove(false)}
          >
            Abbrechen
          </Button>
        </div>
      )}
      {(error || lastProblem) && (
        <p role="alert" className="py-1 text-xs text-destructive">
          {error ?? (lastProblem && describeInstanceGrokFailure(lastProblem))}
        </p>
      )}
    </div>
  );
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
