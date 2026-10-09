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
  type InstanceGrokInput,
} from "../../lib/workjetInstanceGrok";
import type { InstanceGrokAccountPresentation } from "./WorkjetModelsProviders";
import { WORKJET_GATEWAY_PROVIDER_ICONS } from "./WorkjetGatewayAccounts";
import { Button } from "../ui/button";

type Check = NonNullable<WorkjetInstanceGrokResponse["check"]>;
const columns =
  "grid grid-cols-[minmax(9rem,1.15fr)_minmax(0,2fr)_minmax(6rem,.7fr)_2rem_1.75rem] items-center gap-x-3";
const remedies: Readonly<Record<NonNullable<Check["errorCode"]>, string>> = {
  timeout: "The model did not answer within 20 seconds. Retry the check.",
  missing_credential: "Sign in with your Grok Build subscription.",
  model_unavailable: "This model is absent from the account's live catalog. Refresh the models.",
  invalid_response: "The gateway returned no usable answer. Retry the check.",
  request_failed:
    "The gateway request failed. Retry; a failed request does not prove an expired login.",
};

/** Instance-owned subscription; computer gateway accounts remain separate rows. */
export function useInstanceGrokAccount(
  instanceId: string,
  label: string,
): InstanceGrokAccountPresentation {
  const [state, setState] = useState<WorkjetInstanceGrokResponse>();
  const [checks, setChecks] = useState<Readonly<Record<string, Check>>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | undefined>(undefined);
  const retained = useRef<WorkjetInstanceGrokResponse | undefined>(undefined);
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
      try {
        const result = await requestInstanceGrok(instanceId, input, active.signal);
        if (active.signal.aborted || !alive.current) return undefined;
        apply(result);
        return result;
      } catch (failure) {
        if (!active.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : "Grok control failed. Retry the action.",
          );
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
            setError("The sign-in code expired. Start sign-in again.");
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
          else
            setError(
              "Sign-in succeeded, but grok-4.7 is absent from this subscription's live catalog. Refresh models.",
            );
        } else if (result.login?.phase === "failed" || result.login?.phase === "expired") {
          setError("Sign-in did not complete. Start sign-in again.");
        }
      } catch {
        if (!active.signal.aborted)
          setError("Could not follow the sign-in. Refresh this account to continue or cancel.");
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
  const start = () => {
    setConfirmRemove(false);
    void run({ action: "instance.grok.start" }).then((result) => {
      if (
        result?.login?.phase === "accepted" &&
        result.installed &&
        result.models.includes("grok-4.7")
      ) {
        setChecks({});
        void run({ action: "instance.grok.check", modelId: "grok-4.7" });
      }
    });
  };
  const Icon = WORKJET_GATEWAY_PROVIDER_ICONS.xai;
  const login = state?.login;
  const link = login && grokVerificationLink(login.verificationUri);
  const lastProblem = state?.check?.status === "error" ? state.check.errorCode : null;
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
                aria-label={`Add Grok Build account on ${label}`}
                data-workjet-action="models.instance.xai.add-account"
                disabled={!!busy || phase === "pending"}
                onClick={start}
              >
                <PlusIcon className="size-3" />
              </Button>
            )}
          </div>
          <span className="block break-words text-[11px] text-muted-foreground">
            {label} · {state?.installed ? state.accountLabel : "OAuth subscription"}
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
                    ? "Checking…"
                    : check?.status === "ok"
                      ? `Hi check passed · ${check.latencyMs} ms · ${new Date(check.checkedAt).toLocaleString()}`
                      : check?.errorCode
                        ? remedies[check.errorCode]
                        : "Not checked. Click to check."
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
                      ? "Checking"
                      : check?.status === "ok"
                        ? "Check passed"
                        : check?.status === "error"
                          ? (check.errorCode ?? "Check failed")
                          : "Not checked"
                  }
                />
              </button>
            );
          })}
          {state?.installed && state.models.length === 0 && (
            <span className="text-xs text-muted-foreground">
              Live models unavailable. Refresh to retry.
            </span>
          )}
          {!state?.installed && phase !== "pending" && (
            <Button
              size="xs"
              variant="outline"
              disabled={!!busy}
              data-workjet-action="models.instance.xai.sign-in"
              onClick={start}
            >
              Grok Build OAuth
            </Button>
          )}
        </div>
        <span
          role="cell"
          title="This provider has not reported limits."
          className="text-xs text-muted-foreground"
        >
          —
        </span>
        <span
          role="cell"
          title={
            state?.installed
              ? "Subscription stored on this CTOX instance."
              : "No subscription stored."
          }
          className="text-center text-xs text-muted-foreground"
        >
          {state?.installed ? "✓" : "—"}
        </span>
        <div role="cell">
          {state?.installed ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove Grok Build account from ${label}`}
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
              aria-label="Refresh Grok account"
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
            Enter code <strong className="font-mono select-all">{login.userCode}</strong> to sign in
            on {label}.
          </span>
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="underline"
              data-workjet-action="models.instance.xai.open-login"
            >
              Open Grok sign-in
            </a>
          ) : (
            <span role="alert">Invalid sign-in URL. Cancel and retry.</span>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={!!busy}
            onClick={() => {
              void run({ action: "instance.grok.cancel", loginId: login.loginId });
            }}
          >
            Cancel sign-in
          </Button>
        </div>
      )}
      {confirmRemove && (
        <div role="alert" className="flex flex-wrap items-center gap-2 py-2 text-xs">
          <span>Remove this subscription and its saved check from {label}?</span>
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
            Remove
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!!busy}
            onClick={() => setConfirmRemove(false)}
          >
            Cancel
          </Button>
        </div>
      )}
      {(error || lastProblem) && (
        <p role="alert" className="py-1 text-xs text-destructive">
          {error ?? (lastProblem && remedies[lastProblem])}
        </p>
      )}
    </div>
  );
  return {
    row,
    label,
    installed: state?.installed ?? false,
    hasModels: !!state?.models.length,
    checking: busy !== undefined,
    start,
    checkAll,
    refresh: () => {
      void run({ action: "instance.grok.read" });
    },
  };
}
