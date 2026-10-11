import type {
  WorkjetProvisioningPreflight,
  WorkjetProvisioningPreflightResult,
  WorkjetProvisioningSnapshot,
  WorkjetProvisioningTarget,
  WorkjetSshHostKeyInspectResult,
} from "@workjet/contracts";
import { CheckCircle2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

type Stage = "target" | "fingerprint" | "preflight" | "components" | "operation";
type RetryStep = "inspect" | "preflight" | "start" | "start-backend";

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Einrichtung fehlgeschlagen.";
}

function stageLabel(snapshot: WorkjetProvisioningSnapshot): string {
  return snapshot.events.at(-1)?.message ?? "Wird vorbereitet";
}

/**
 * Befund 3 (11.10.2026): Ein Preflight-Ergebnis darf nie still auf die
 * Fingerprint-Bestätigung zurückspringen. Nur Host-Key-Codes führen dorthin,
 * und auch dann mit Fehlerzeile; alles andere bleibt als Fehlerzeile mit
 * „Erneut versuchen“ stehen. Erfolg führt immer zum nächsten Schritt.
 */
export function preflightOutcome(
  result: WorkjetProvisioningPreflightResult,
):
  | { readonly next: "components"; readonly preflight: WorkjetProvisioningPreflight }
  | { readonly next: "fingerprint" | "error"; readonly message: string } {
  if (result._tag === "ready") return { next: "components", preflight: result.preflight };
  return {
    next:
      result.code === "host_key_confirmation_required" || result.code === "host_key_changed"
        ? "fingerprint"
        : "error",
    message: result.message.trim() || "Prüfung fehlgeschlagen.",
  };
}

export interface ProvisioningSshTargetInput {
  readonly host: string;
  readonly username: string | null;
  readonly port: number | null;
}

/**
 * Laufzeit auf einem Rechner prüfen und installieren (Reparieren in der
 * Rechner-Zeile, Instanz einrichten). Alles inline, ohne Dialog.
 */
export function ComputerProvisioningSection({
  initialKind = "local",
  fixedTargetKind = false,
  initialTarget,
  onCompleted,
  onBusyChange,
}: {
  readonly initialKind?: "local" | "ssh";
  readonly fixedTargetKind?: boolean;
  /** Bekannte Verbindung der Zeile: Adresse, Benutzer, Port werden übernommen. */
  readonly initialTarget?: ProvisioningSshTargetInput;
  readonly onCompleted?: () => void;
  readonly onBusyChange?: (busy: boolean) => void;
} = {}) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const supported =
    bridge?.inspectProvisioningHostKey !== undefined &&
    bridge.preflightProvisioningTarget !== undefined &&
    bridge.startProvisioningOperation !== undefined &&
    bridge.getProvisioningOperation !== undefined;
  const [kind, setKind] = useState<"local" | "ssh">(initialKind);
  const [host, setHost] = useState(initialTarget?.host ?? "");
  const [username, setUsername] = useState(initialTarget?.username ?? "");
  const [port, setPort] = useState(String(initialTarget?.port ?? 22));
  const [stage, setStage] = useState<Stage>("target");
  const [hostKey, setHostKey] = useState<WorkjetSshHostKeyInspectResult | null>(null);
  const [preflight, setPreflight] = useState<WorkjetProvisioningPreflight | null>(null);
  const [installWorkjet, setInstallWorkjet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<WorkjetProvisioningSnapshot | null>(null);
  const [fehler, setFehler] = useState<{ message: string; retry: RetryStep } | null>(null);

  const target = useMemo<WorkjetProvisioningTarget>(() => {
    if (kind === "local") return { _tag: "local" };
    const parsedPort = Number.parseInt(port, 10);
    return {
      _tag: "ssh",
      ssh: {
        alias: host.trim(),
        hostname: host.trim(),
        username: username.trim() || null,
        port: Number.isInteger(parsedPort) ? parsedPort : 22,
      },
    };
  }, [host, kind, port, username]);

  // Eine laufende Installation für dasselbe Ziel wird gezeigt, nie neu gestartet.
  useEffect(() => {
    let cancelled = false;
    if (!bridge?.listProvisioningOperations) return;
    void bridge
      .listProvisioningOperations()
      .then((result) => {
        if (cancelled || result._tag !== "found") return;
        const running = result.operations.find(
          (entry) =>
            (entry.operation.state === "queued" || entry.operation.state === "running") &&
            (entry.target._tag === "local"
              ? initialKind === "local"
              : entry.target.ssh.hostname === (initialTarget?.host ?? "")),
        );
        if (running) {
          setOperation(running.operation);
          setStage("operation");
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge, initialKind, initialTarget?.host]);

  useEffect(() => {
    if (!operation || (operation.state !== "queued" && operation.state !== "running")) return;
    const timer = window.setInterval(() => {
      const currentBridge = window.desktopBridge;
      if (!currentBridge?.getProvisioningOperation) return;
      void currentBridge
        .getProvisioningOperation(operation.operationId)
        .then((result) => {
          if (result._tag === "found") {
            setOperation(result.operation);
            setFehler(null);
          } else {
            setFehler({
              message: result._tag === "failed" ? result.message : "Vorgang nicht gefunden.",
              retry: "preflight",
            });
          }
        })
        .catch(() => setFehler({ message: "Status nicht abrufbar.", retry: "preflight" }));
    }, 500);
    return () => window.clearInterval(timer);
  }, [operation]);

  const completedId = useRef<string | null>(null);
  const running = busy || operation?.state === "queued" || operation?.state === "running";
  useEffect(() => {
    onBusyChange?.(running);
    return () => onBusyChange?.(false);
  }, [running, onBusyChange]);
  useEffect(() => {
    if (operation?.state === "completed" && completedId.current !== operation.operationId) {
      completedId.current = operation.operationId;
      onCompleted?.();
    }
  }, [operation, onCompleted]);

  if (!supported)
    return fixedTargetKind ? (
      <p role="alert" className="text-xs text-destructive">
        Nur mit der Desktop-App.
      </p>
    ) : null;

  const runPreflight = async (
    selectedTarget = target,
    confirmedHostKeyFingerprint = hostKey?._tag === "ready" ? hostKey.fingerprint : undefined,
  ) => {
    setBusy(true);
    setStage("preflight");
    setFehler(null);
    try {
      const result = await bridge.preflightProvisioningTarget!({
        target: selectedTarget,
        ...(confirmedHostKeyFingerprint === undefined ? {} : { confirmedHostKeyFingerprint }),
      });
      const outcome = preflightOutcome(result);
      if (outcome.next === "components") {
        setPreflight(outcome.preflight);
        setInstallWorkjet(outcome.preflight.graphicalSession);
        setStage("components");
        return;
      }
      setStage(outcome.next === "fingerprint" && hostKey?._tag === "ready" ? "fingerprint" : "preflight");
      setFehler({
        message: outcome.message,
        retry: outcome.next === "fingerprint" ? "inspect" : "preflight",
      });
    } catch (failure) {
      // Ein abgelaufener IPC-Aufruf ist kein Grund, zur Bestätigung zurückzuspringen.
      setFehler({ message: errorText(failure), retry: "preflight" });
    } finally {
      setBusy(false);
    }
  };

  const inspect = async () => {
    if (kind === "ssh" && host.trim() === "") return;
    setBusy(true);
    setFehler(null);
    try {
      const result = await bridge.inspectProvisioningHostKey!(target);
      setHostKey(result);
      if (result._tag === "failed") {
        setStage("target");
        setFehler({ message: result.message, retry: "inspect" });
        return;
      }
      if (result._tag === "not_required") {
        await runPreflight(target, undefined);
        return;
      }
      setStage("fingerprint");
    } catch (failure) {
      setStage("target");
      setFehler({ message: errorText(failure), retry: "inspect" });
    } finally {
      setBusy(false);
    }
  };

  const start = async (action: "install" | "start" = "install") => {
    if (!preflight) return;
    setBusy(true);
    setFehler(null);
    try {
      const result = await bridge.startProvisioningOperation!({
        preflightId: preflight.preflightId,
        action,
        components:
          action === "install" && installWorkjet ? ["ctox-backend", "workjet"] : ["ctox-backend"],
        channel: "stable",
      });
      if (result._tag === "failed") {
        setFehler({
          message: result.message,
          retry: action === "start" ? "start-backend" : "start",
        });
        return;
      }
      setOperation(result.operation);
      setStage("operation");
    } catch (failure) {
      setFehler({ message: errorText(failure), retry: action === "start" ? "start-backend" : "start" });
    } finally {
      setBusy(false);
    }
  };

  const retry = () => {
    if (!fehler) return;
    if (fehler.retry === "inspect") void inspect();
    else if (fehler.retry === "preflight") void runPreflight();
    else void start(fehler.retry === "start-backend" ? "start" : "install");
  };

  const reset = () => {
    setStage("target");
    setHostKey(null);
    setPreflight(null);
    setOperation(null);
    setFehler(null);
  };

  return (
    <div className="space-y-3 text-[13.5px]" data-slot="computer-provisioning">
      {stage === "target" ? (
        <div className="flex flex-wrap items-end gap-2">
          {!fixedTargetKind ? (
            <div className="flex gap-1" role="radiogroup" aria-label="Ziel">
              {(
                [
                  ["local", "Local"],
                  ["ssh", "SSH"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={kind === value}
                  variant={kind === value ? "default" : "outline"}
                  onClick={() => setKind(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
          ) : null}
          {kind === "ssh" ? (
            <>
              <label className="grid min-w-40 flex-1 gap-1 text-xs text-muted-foreground">
                Adresse
                <Input
                  nativeInput
                  size="sm"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="gpu3 oder 100.x.x.x"
                  autoComplete="off"
                />
              </label>
              <label className="grid w-32 gap-1 text-xs text-muted-foreground">
                Benutzer
                <Input
                  nativeInput
                  size="sm"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                />
              </label>
              <label className="grid w-20 gap-1 text-xs text-muted-foreground">
                Port
                <Input
                  nativeInput
                  size="sm"
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  inputMode="numeric"
                />
              </label>
            </>
          ) : null}
          <Button
            type="button"
            size="sm"
            onClick={() => void inspect()}
            disabled={busy || (kind === "ssh" && host.trim() === "")}
          >
            {busy ? <Spinner className="size-3.5" /> : null}
            Prüfen
          </Button>
        </div>
      ) : null}

      {stage === "fingerprint" && hostKey?._tag === "ready" ? (
        <div className="flex flex-wrap items-center gap-2" data-slot="host-key-confirm">
          <span className="text-muted-foreground">Host-Schlüssel</span>
          <code className="min-w-0 select-all truncate rounded bg-muted px-1.5 py-0.5 text-xs">
            {hostKey.algorithm} {hostKey.fingerprint}
          </code>
          <Button type="button" size="xs" disabled={busy} onClick={() => void runPreflight()}>
            {busy ? <Spinner className="size-3" /> : null}
            Bestätigen
          </Button>
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={reset}>
            Abbrechen
          </Button>
        </div>
      ) : null}

      {stage === "preflight" && busy ? (
        <div className="flex items-center gap-2 text-muted-foreground" role="status">
          <Spinner className="size-3.5" /> Prüft Plattform, Internet, Rechte…
        </div>
      ) : null}

      {stage === "components" && preflight ? (
        <div className="space-y-2" data-slot="provisioning-components">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="rounded bg-muted px-1.5 py-0.5">
              {preflight.platform} · {preflight.architecture}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5">
              {preflight.graphicalSession ? "Desktop" : "Headless"}
            </span>
            {preflight.ctoxInstalledVersion !== null ? (
              <span className="rounded bg-muted px-1.5 py-0.5">
                CTOX {preflight.ctoxInstalledVersion}
              </span>
            ) : null}
          </div>
          {preflight.warnings.map((warning) => (
            <p key={warning} className="text-xs text-amber-600 dark:text-amber-400">
              {warning}
            </p>
          ))}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <label className="flex items-center gap-2">
              <Checkbox checked disabled />
              CTOX
            </label>
            <label className="flex items-center gap-2 has-disabled:opacity-60">
              <Checkbox
                checked={installWorkjet}
                disabled={!preflight.graphicalSession}
                onCheckedChange={(checked) => setInstallWorkjet(checked === true)}
              />
              Workjet
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => void start()} disabled={busy}>
              {busy ? <Spinner className="size-3.5" /> : null}
              Installieren
            </Button>
            {preflight.ctoxInstalledVersion !== null ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void start("start")}
              >
                CTOX starten
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={reset}>
              Abbrechen
            </Button>
          </div>
        </div>
      ) : null}

      {stage === "operation" && operation ? (
        <div className="space-y-2" data-slot="provisioning-operation">
          <div className="flex items-center gap-2 font-medium">
            {operation.state === "completed" ? (
              <CheckCircle2Icon className="size-4 text-emerald-500" />
            ) : operation.state !== "running" && operation.state !== "queued" ? (
              <span className="size-2 rounded-full bg-destructive" />
            ) : (
              <Spinner className="size-4" />
            )}
            {stageLabel(operation)}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${operation.events.at(-1)?.percent ?? 0}%` }}
            />
          </div>
          <ol className="max-h-40 space-y-0.5 overflow-auto text-xs" aria-live="polite">
            {operation.events.map((event) => (
              <li key={event.sequence}>
                <span className="mr-2 text-muted-foreground">{event.percent}%</span>
                {event.message}
              </li>
            ))}
          </ol>
          {operation.state === "interrupted" ? (
            <p role="alert" className="text-xs text-destructive">
              Ergebnis unbekannt. Zustand auf dem Rechner prüfen.
            </p>
          ) : null}
          {operation.state !== "running" && operation.state !== "queued" ? (
            <Button type="button" size="sm" variant="outline" onClick={reset}>
              Neu prüfen
            </Button>
          ) : null}
        </div>
      ) : null}

      {fehler ? (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-slot="provisioning-error">
          <span role="alert" className="min-w-0 text-destructive">
            {fehler.message}
          </span>
          <Button type="button" size="xs" variant="outline" disabled={busy} onClick={retry}>
            Erneut versuchen
          </Button>
        </div>
      ) : null}
    </div>
  );
}
