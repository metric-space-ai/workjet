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
import { Segment } from "../ui/segment";
import { Spinner } from "../ui/spinner";

type Stage = "target" | "fingerprint" | "preflight" | "components" | "operation";
type RetryStep = "inspect" | "preflight" | "start" | "start-backend";

/**
 * D02: Die Desktop-App meldet englische Rohtexte. Bekannte Texte werden hier
 * auf kurze deutsche Zeilen (≤ 12 Wörter) abgebildet; der Rohtext bleibt nur
 * hinter „Details“.
 */
const PROVISIONING_MESSAGES_DE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Operation queued/i, "In der Warteschlange"],
  [/^Requested components are ready/i, "Komponenten bereit"],
  [/^Verified the approved target/i, "Ziel und Release-Kanal geprüft"],
  [/^Requesting target authorization/i, "Rechte auf dem Rechner anfragen"],
  [/^Creating a local-only Business OS pairing invite/i, "Kopplung wird vorbereitet"],
  [/^CTOX \w+ completed/i, "CTOX fertig"],
  [/^Confirm the current SSH host-key fingerprint/i, "Host-Schlüssel bestätigen"],
  [/^The SSH host key changed/i, "Host-Schlüssel hat sich geändert"],
  [/^The target did not publish an SSH host key/i, "Rechner liefert keinen Host-Schlüssel"],
  [/^The SSH host key response was invalid/i, "Host-Schlüssel ungültig"],
  [/^The SSH fingerprint could not be calculated/i, "Host-Schlüssel nicht prüfbar"],
  [/^The target operating system is not supported/i, "Betriebssystem wird nicht unterstützt"],
  [/^The target architecture is not supported/i, "Prozessor wird nicht unterstützt"],
  [/^The target is missing required provisioning tools/i, "Auf dem Rechner fehlen Werkzeuge"],
  [/^The target cannot reach the official CTOX release channel/i, "Rechner erreicht den CTOX-Release-Kanal nicht"],
  [/administrator/i, "Administratorrechte nötig"],
  [/^Windows will show a User Account Control/i, "Windows fragt gleich nach Administratorrechten"],
  [/^No active graphical session/i, "Ohne Desktop: nur CTOX installierbar"],
  [/^Workjet is unavailable on a headless target/i, "Ohne Desktop: nur CTOX installierbar"],
  [/^Workjet cannot be installed without an active graphical session/i, "Ohne Desktop: nur CTOX installierbar"],
  [/^Run the target preflight again/i, "Prüfung abgelaufen"],
  [/installation journal|Saved installations could not be read/i, "Gespeicherte Installation nicht lesbar"],
  [/^Target preflight failed/i, "Prüfung fehlgeschlagen"],
  [/^Provisioning failed/i, "Einrichtung fehlgeschlagen"],
  [/^Approved SSH (target|host key) is missing/i, "Bestätigung fehlt, neu prüfen"],
  [/password|permission denied|authentication/i, "Anmeldung abgelehnt"],
  [/timed? ?out|timeout/i, "Zeitüberschreitung"],
  [/unreachable|no route|could not resolve|connection refused/i, "Rechner nicht erreichbar"],
];

const PROVISIONING_PHASES_DE: Readonly<Record<string, string>> = {
  queued: "In der Warteschlange",
  preflight: "Prüfung",
  authorization: "Rechte anfragen",
  download: "Download",
  verification: "Überprüfung",
  installation: "Installation",
  service: "Dienst starten",
  health: "Zustand prüfen",
  pairing: "Kopplung",
  replication: "Abgleich",
  complete: "Fertig",
  failed: "Fehlgeschlagen",
};

/** Deutscher Text zu einer Desktop-Meldung; `raw` nur, wenn er abweicht (für „Details“). */
export function provisioningMessageDe(
  message: string,
  fallback = "Einrichtung fehlgeschlagen",
): { readonly text: string; readonly raw: string | null } {
  const trimmed = message.trim();
  // Schon deutsch (Umlaute oder bekannte Wörter): unverändert.
  if (trimmed !== "" && /[äöüß]|^(Prüf|Rechner|Einricht|Anmeld|Kein|Nicht)/i.test(trimmed))
    return { text: trimmed, raw: null };
  const match = PROVISIONING_MESSAGES_DE.find(([pattern]) => pattern.test(trimmed));
  const text = match ? match[1] : fallback;
  return { text, raw: trimmed !== "" && trimmed !== text ? trimmed : null };
}

function eventText(event: WorkjetProvisioningSnapshot["events"][number]): {
  readonly text: string;
  readonly raw: string | null;
} {
  return provisioningMessageDe(event.message, PROVISIONING_PHASES_DE[event.phase] ?? "Einrichtung");
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Einrichtung fehlgeschlagen.";
}

function stageLabel(snapshot: WorkjetProvisioningSnapshot): string {
  const last = snapshot.events.at(-1);
  return last ? eventText(last).text : "Wird vorbereitet";
}

const PLATFORM_DE: Readonly<Record<string, string>> = {
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
};

/** Rohtext nur hinter „Details“ (D02, D13). */
function RawDetails({ raw }: { readonly raw: string | null }) {
  if (raw === null) return null;
  return (
    <details className="text-xs text-muted-foreground" data-slot="provisioning-details">
      <summary className="cursor-pointer select-none">Details</summary>
      <p className="mt-1 select-text break-all">{raw}</p>
    </details>
  );
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
  const knownTarget = fixedTargetKind && initialTarget !== undefined && initialTarget.host !== "";
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
      setStage(
        outcome.next === "fingerprint" && hostKey?._tag === "ready" ? "fingerprint" : "preflight",
      );
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
      setFehler({
        message: errorText(failure),
        retry: action === "start" ? "start-backend" : "start",
      });
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
            <Segment
              aria-label="Ziel"
              value={kind}
              onValueChange={setKind}
              options={[
                { value: "local", label: "Lokal" },
                { value: "ssh", label: "SSH" },
              ]}
            />
          ) : null}
          {kind === "ssh" && knownTarget ? (
            // D13: bekanntes Ziel nur lesend, nicht erneut abfragen.
            <span className="min-w-0 truncate text-muted-foreground" data-slot="provisioning-target">
              {username.trim() ? `${username.trim()}@` : ""}
              {host}
              {port !== "22" ? `:${port}` : ""}
            </span>
          ) : kind === "ssh" ? (
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
        <div className="space-y-1" data-slot="host-key-confirm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Host-Schlüssel bestätigen</span>
            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={reset}>
              Abbrechen
            </Button>
            <Button type="button" size="xs" disabled={busy} onClick={() => void runPreflight()}>
              {busy ? <Spinner className="size-3" /> : null}
              Bestätigen
            </Button>
          </div>
          {/* D13: Fingerabdruck als Rohwert nur hinter „Details“. */}
          <RawDetails raw={`${hostKey.algorithm} ${hostKey.fingerprint}`} />
        </div>
      ) : null}

      {stage === "preflight" && busy ? (
        <div className="flex items-center gap-2 text-muted-foreground" role="status">
          <Spinner className="size-3.5" /> Prüft Plattform, Internet, Rechte…
        </div>
      ) : null}

      {stage === "components" && preflight ? (
        <div className="space-y-2" data-slot="provisioning-components">
          <p className="text-xs text-muted-foreground" data-slot="provisioning-facts">
            {[
              PLATFORM_DE[preflight.platform] ?? preflight.platform,
              preflight.graphicalSession ? null : "ohne Desktop",
              preflight.ctoxInstalledVersion !== null
                ? `CTOX ${preflight.ctoxInstalledVersion}`
                : null,
            ]
              .filter((part): part is string => part !== null)
              .join(" · ")}
          </p>
          {[...new Set(preflight.warnings.map((warning) => provisioningMessageDe(warning).text))].map(
            (warning) => (
              <p key={warning} className="text-xs text-amber-600 dark:text-amber-400">
                {warning}
              </p>
            ),
          )}
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
                {eventText(event).text}
              </li>
            ))}
          </ol>
          {operation.state === "interrupted" ? (
            <p role="alert" className="text-xs text-destructive">
              Ergebnis unbekannt. Zustand auf dem Rechner prüfen.
            </p>
          ) : null}
          {operation.state === "failed" ? (
            <RawDetails raw={operation.events.at(-1)?.message ?? null} />
          ) : null}
          {operation.state !== "running" && operation.state !== "queued" ? (
            <Button type="button" size="sm" variant="outline" onClick={reset}>
              Neu prüfen
            </Button>
          ) : null}
        </div>
      ) : null}

      {fehler ? (
        <div className="space-y-1" data-slot="provisioning-error">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span role="alert" className="min-w-0 text-destructive">
              {provisioningMessageDe(fehler.message).text}
            </span>
            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={retry}>
              Erneut versuchen
            </Button>
          </div>
          <RawDetails raw={provisioningMessageDe(fehler.message).raw} />
        </div>
      ) : null}
    </div>
  );
}
