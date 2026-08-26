import type {
  WorkjetProvisioningPreflight,
  WorkjetProvisioningSnapshot,
  WorkjetProvisioningTarget,
  WorkjetSshHostKeyInspectResult,
} from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  LaptopIcon,
  RefreshCwIcon,
  ServerCogIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type Stage = "target" | "fingerprint" | "preflight" | "components" | "operation";

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The provisioning request failed.";
}

function stageLabel(snapshot: WorkjetProvisioningSnapshot): string {
  return snapshot.events.at(-1)?.message ?? "Preparing operation";
}

export function ComputerProvisioningSection() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const supported =
    bridge?.inspectProvisioningHostKey !== undefined &&
    bridge.preflightProvisioningTarget !== undefined &&
    bridge.startProvisioningOperation !== undefined &&
    bridge.getProvisioningOperation !== undefined;
  const [kind, setKind] = useState<"local" | "ssh">("local");
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [port, setPort] = useState("22");
  const [stage, setStage] = useState<Stage>("target");
  const [hostKey, setHostKey] = useState<WorkjetSshHostKeyInspectResult | null>(null);
  const [hostKeyConfirmed, setHostKeyConfirmed] = useState(false);
  const [preflight, setPreflight] = useState<WorkjetProvisioningPreflight | null>(null);
  const [installWorkjet, setInstallWorkjet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<WorkjetProvisioningSnapshot | null>(null);

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

  useEffect(() => {
    if (!operation || operation.state === "completed" || operation.state === "failed") return;
    const timer = window.setInterval(() => {
      const currentBridge = window.desktopBridge;
      if (!currentBridge?.getProvisioningOperation) return;
      void currentBridge.getProvisioningOperation(operation.operationId).then((result) => {
        if (result._tag === "found") setOperation(result.operation);
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [operation]);

  if (!supported) return null;

  const inspect = async () => {
    if (kind === "ssh" && host.trim() === "") return;
    setBusy(true);
    try {
      const result = await bridge.inspectProvisioningHostKey!(target);
      setHostKey(result);
      if (result._tag === "failed") throw new Error(result.message);
      setStage(result._tag === "not_required" ? "preflight" : "fingerprint");
      if (result._tag === "not_required") await runPreflight(target, undefined);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not inspect computer",
        description: errorText(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const runPreflight = async (
    selectedTarget = target,
    confirmedHostKeyFingerprint = hostKey?._tag === "ready" ? hostKey.fingerprint : undefined,
  ) => {
    setBusy(true);
    setStage("preflight");
    try {
      const result = await bridge.preflightProvisioningTarget!({
        target: selectedTarget,
        ...(confirmedHostKeyFingerprint === undefined ? {} : { confirmedHostKeyFingerprint }),
      });
      if (result._tag === "failed") throw new Error(result.message);
      setPreflight(result.preflight);
      setInstallWorkjet(result.preflight.graphicalSession);
      setStage("components");
    } catch (error) {
      toastManager.add({ type: "error", title: "Preflight failed", description: errorText(error) });
      setStage(kind === "ssh" ? "fingerprint" : "target");
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!preflight) return;
    setBusy(true);
    try {
      const result = await bridge.startProvisioningOperation!({
        preflightId: preflight.preflightId,
        action: "install",
        components: installWorkjet ? ["ctox-backend", "workjet"] : ["ctox-backend"],
        channel: "stable",
      });
      if (result._tag === "failed") throw new Error(result.message);
      setOperation(result.operation);
      setStage("operation");
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start installation",
        description: errorText(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStage("target");
    setHostKey(null);
    setHostKeyConfirmed(false);
    setPreflight(null);
    setOperation(null);
  };

  return (
    <SettingsSection title="Install on a computer">
      <SettingsRow
        title="Provision CTOX and Workjet"
        description="Install a CTOX backend on this computer or an SSH target. Workjet can also be installed when a graphical session is available. Downloads happen on the target and are checksum-verified against the official signed release manifest."
      >
        <div className="max-w-2xl space-y-4 pb-4 pt-2">
          {stage === "target" ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  variant={kind === "local" ? "default" : "outline"}
                  onClick={() => setKind("local")}
                >
                  <LaptopIcon className="size-4" /> This computer
                </Button>
                <Button
                  type="button"
                  variant={kind === "ssh" ? "default" : "outline"}
                  onClick={() => setKind("ssh")}
                >
                  <ServerCogIcon className="size-4" /> Remote over SSH
                </Button>
              </div>
              {kind === "ssh" ? (
                <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-3">
                  <label className="space-y-1 text-xs font-medium sm:col-span-3">
                    Host or IP address
                    <Input
                      nativeInput
                      value={host}
                      onChange={(event) => setHost(event.target.value)}
                      placeholder="gpu3.example.net"
                      autoComplete="off"
                    />
                  </label>
                  <label className="space-y-1 text-xs font-medium sm:col-span-2">
                    User
                    <Input
                      nativeInput
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      placeholder="operator"
                      autoComplete="username"
                    />
                  </label>
                  <label className="space-y-1 text-xs font-medium">
                    Port
                    <Input
                      nativeInput
                      value={port}
                      onChange={(event) => setPort(event.target.value)}
                      inputMode="numeric"
                    />
                  </label>
                  <p className="text-xs text-muted-foreground sm:col-span-3">
                    Passwords and SSH passphrases are requested by the desktop main process only and
                    are never stored.
                  </p>
                </div>
              ) : null}
              <Button
                type="button"
                onClick={() => void inspect()}
                disabled={busy || (kind === "ssh" && host.trim() === "")}
              >
                {busy ? <Spinner className="size-4" /> : <ShieldCheckIcon className="size-4" />}
                {kind === "ssh" ? "Inspect host key" : "Run preflight"}
              </Button>
            </>
          ) : null}

          {stage === "fingerprint" && hostKey?._tag === "ready" ? (
            <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
              <div>
                <p className="text-sm font-medium">Confirm SSH host fingerprint</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Compare this fingerprint with a trusted source for the target before continuing.
                </p>
              </div>
              <code className="block select-all break-all rounded bg-muted p-3 text-xs">
                {hostKey.algorithm} · {hostKey.fingerprint}
              </code>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={hostKeyConfirmed}
                  onCheckedChange={(checked) => setHostKeyConfirmed(checked === true)}
                />
                I independently verified this exact fingerprint.
              </label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  onClick={() => void runPreflight()}
                  disabled={!hostKeyConfirmed || busy}
                >
                  {busy ? <Spinner className="size-4" /> : <ShieldCheckIcon className="size-4" />}{" "}
                  Confirm and connect
                </Button>
                <Button type="button" variant="outline" onClick={reset}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {stage === "preflight" ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Checking platform, internet, administrator rights and
              graphical session…
            </div>
          ) : null}

          {stage === "components" && preflight ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-border p-3 text-sm">
                <p className="font-medium">
                  {preflight.platform} · {preflight.architecture}
                </p>
                <p className="text-xs text-muted-foreground">
                  Internet ready · Administrator ready ·{" "}
                  {preflight.graphicalSession ? "Graphical session detected" : "Headless target"}
                </p>
                {preflight.warnings.map((warning) => (
                  <p key={warning} className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                    {warning}
                  </p>
                ))}
              </div>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked disabled />
                <span>
                  <span className="font-medium">CTOX backend</span>
                  <span className="block text-xs text-muted-foreground">
                    Required for Business OS sync on this computer.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={installWorkjet}
                  disabled={!preflight.graphicalSession}
                  onCheckedChange={(checked) => setInstallWorkjet(checked === true)}
                />
                <span>
                  <span className="font-medium">Workjet desktop app</span>
                  <span className="block text-xs text-muted-foreground">
                    Optional; installed without launching it. Unavailable on headless computers.
                  </span>
                </span>
              </label>
              <div className="flex gap-2">
                <Button type="button" onClick={() => void start()} disabled={busy}>
                  {busy ? <Spinner className="size-4" /> : <ServerCogIcon className="size-4" />}{" "}
                  Install selected components
                </Button>
                <Button type="button" variant="outline" onClick={reset}>
                  Back
                </Button>
              </div>
            </div>
          ) : null}

          {stage === "operation" && operation ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                {operation.state === "completed" ? (
                  <CheckCircle2Icon className="size-4 text-emerald-500" />
                ) : operation.state === "failed" ? (
                  <span className="size-2 rounded-full bg-destructive" />
                ) : (
                  <Spinner className="size-4" />
                )}
                {stageLabel(operation)}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${operation.events.at(-1)?.percent ?? 0}%` }}
                />
              </div>
              <div
                className="max-h-48 space-y-1 overflow-auto rounded-lg border border-border p-3"
                aria-live="polite"
              >
                {operation.events.map((event) => (
                  <p key={event.sequence} className="text-xs">
                    <span className="mr-2 text-muted-foreground">{event.percent}%</span>
                    {event.message}
                  </p>
                ))}
              </div>
              {operation.state === "completed" ? (
                <p className="text-xs text-muted-foreground">
                  CTOX is installed, healthy and paired with this Workjet profile. Select the
                  backend for a Business OS session below; a remotely installed Workjet app was not
                  started.
                </p>
              ) : null}
              {operation.state === "completed" || operation.state === "failed" ? (
                <Button type="button" variant="outline" onClick={reset}>
                  <RefreshCwIcon className="size-4" /> Provision another computer
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </SettingsRow>
      <SettingsRow
        title="Business data stays in sync"
        description="Provisioning uses HTTP only for signed release metadata, health and pairing control. Business OS records are never proxied over HTTP."
      />
    </SettingsSection>
  );
}
