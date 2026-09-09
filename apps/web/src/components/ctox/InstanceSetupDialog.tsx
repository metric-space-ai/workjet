import { useState, useSyncExternalStore } from "react";
import {
  closeInstanceSetup,
  instanceSetupStore,
  type InstanceSetupIntent,
} from "../../instanceSetup";
import { canActivateCtoxInstance, PairingAddSurface, useCtoxMode } from "./CtoxModeShell";
import { ctoxInstanceDisplayTitle } from "./ctoxInstanceDisplayTitle";
import { ComputerProvisioningSection } from "../settings/ComputerProvisioningSection";
import { InstanceQrScanner } from "./InstanceQrScanner";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function InstanceSetupDialog() {
  const [busy, setBusy] = useState(false);
  const request = useSyncExternalStore(
    instanceSetupStore.subscribe,
    instanceSetupStore.getSnapshot,
    () => null,
  );
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy) closeInstanceSetup();
      }}
    >
      <DialogPopup className="max-h-[85dvh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>CTOX-Instanz verbinden oder einrichten</DialogTitle>
          <DialogDescription>
            Der CTOX-Master synchronisiert dein Netzwerk und liefert Ops aus. Weitere Computer
            führen Aufgaben aus.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {request ? (
            <InstanceSetupContent
              key={request.revision}
              initialIntent={request.intent}
              onBusyChange={setBusy}
              busy={busy}
            />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function InstanceSetupContent({
  initialIntent,
  onBusyChange,
  busy,
}: {
  readonly initialIntent: InstanceSetupIntent;
  readonly onBusyChange: (busy: boolean) => void;
  readonly busy: boolean;
}) {
  const mode = useCtoxMode();
  const [step, setStep] = useState<
    InstanceSetupIntent | "local" | "ssh" | "tailscale" | "managed" | "select"
  >(["qr", "link", "manual"].includes(initialIntent) ? "connect" : initialIntent);
  const [connectMethod, setConnectMethod] = useState<"link" | "qr" | "manual">(
    initialIntent === "qr" || initialIntent === "manual" ? initialIntent : "link",
  );
  const [scannedInvite, setScannedInvite] = useState("");
  const [scanRevision, setScanRevision] = useState(0);
  const instances =
    mode.discovery !== "loading" && mode.discovery._tag === "ready" ? mode.discovery.instances : [];
  const chooseDiscovered = () => {
    mode.refresh();
    setStep("select");
  };
  const instanceList = (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Wähle die Instanz, in der du dein erstes Projekt anlegen möchtest.
      </p>
      {instances.length === 0 ? (
        <p role="status" className="text-sm">
          Noch keine Instanz gefunden. Prüfe den Verbindungsstatus oder aktualisiere die Liste.
        </p>
      ) : null}
      {instances
        .filter((instance) => step !== "managed" || instance.source === "ctox_dev")
        .map((instance) => (
          <Button
            key={instance.id}
            variant="outline"
            className="w-full justify-start"
            disabled={!canActivateCtoxInstance(instance)}
            onClick={() => {
              mode.select(instance);
              closeInstanceSetup();
            }}
          >
            {ctoxInstanceDisplayTitle(instance)}
            {!canActivateCtoxInstance(instance) ? " · Nicht erreichbar" : ""}
          </Button>
        ))}
      <Button variant="outline" disabled={mode.refreshing} onClick={mode.refresh}>
        {mode.refreshing ? "Wird geprüft…" : "Instanzen aktualisieren"}
      </Button>
    </div>
  );
  return (
    <div className="space-y-4">
      {step !== "choose" ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setStep("choose");
            setScannedInvite("");
          }}
        >
          Zurück zur Auswahl
        </Button>
      ) : null}
      {step === "choose" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Button
            className="h-auto min-h-24 flex-col items-start justify-start gap-2 whitespace-normal p-4 text-left sm:h-auto"
            onClick={() => setStep("create")}
          >
            <span>Neue Instanz erstellen</span>
            <span className="text-xs font-normal">
              Auf einem Computer oder verwaltet über ctox.dev
            </span>
          </Button>
          <Button
            variant="outline"
            className="h-auto min-h-24 flex-col items-start justify-start gap-2 whitespace-normal p-4 text-left sm:h-auto"
            onClick={() => setStep("connect")}
          >
            <span>Vorhandene Instanz verbinden</span>
            <span className="text-xs font-normal">Mit QR-Code, Link oder Verbindungsdaten</span>
          </Button>
          {instances.length > 0 ? (
            <Button variant="ghost" onClick={() => setStep("select")}>
              Bereits eingerichtete Instanz auswählen
            </Button>
          ) : null}
        </div>
      ) : null}
      {step === "create" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="outline" onClick={() => setStep("local")}>
            Auf diesem Computer
          </Button>
          <Button variant="outline" onClick={() => setStep("ssh")}>
            Auf einem SSH-Rechner
          </Button>
          <Button variant="outline" onClick={() => setStep("tailscale")}>
            Auf einem Tailscale-Rechner
          </Button>
          <Button variant="outline" onClick={() => setStep("managed")}>
            Verwaltet über ctox.dev
          </Button>
        </div>
      ) : null}
      {step === "local" || step === "ssh" || step === "tailscale" ? (
        <>
          {step === "tailscale" ? (
            <p className="text-sm">
              Beide Computer müssen mit Tailscale verbunden sein. Verwende die Tailscale-IP oder den
              Hostnamen.
            </p>
          ) : null}
          <ComputerProvisioningSection
            key={step}
            initialKind={step === "local" ? "local" : "ssh"}
            fixedTargetKind
            onCompleted={chooseDiscovered}
            onBusyChange={onBusyChange}
          />
        </>
      ) : null}
      {step === "managed" ? (
        <div className="space-y-3">
          <p className="text-sm">
            Melde dich an, um deine verwalteten Instanzen zu laden. Eine neue verwaltete Instanz
            legst du bei ctox.dev an.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={mode.login}>Bei ctox.dev anmelden</Button>
            <Button
              variant="outline"
              render={<a href="https://ctox.dev" target="_blank" rel="noopener noreferrer" />}
            >
              Neue Instanz bei ctox.dev
            </Button>
          </div>
          {instanceList}
        </div>
      ) : null}
      {step === "connect" ? (
        <div className="space-y-3">
          <Button variant="ghost" disabled={busy} onClick={() => setStep("managed")}>
            Bei ctox.dev anmelden
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              variant={connectMethod === "qr" ? "default" : "outline"}
              onClick={() => {
                setConnectMethod("qr");
                setScanRevision((value) => value + 1);
              }}
            >
              QR-Code scannen
            </Button>
            <Button
              disabled={busy}
              variant={connectMethod === "link" ? "default" : "outline"}
              onClick={() => setConnectMethod("link")}
            >
              Link eingeben
            </Button>
            <Button
              disabled={busy}
              variant={connectMethod === "manual" ? "default" : "outline"}
              onClick={() => setConnectMethod("manual")}
            >
              Verbindungsdaten eingeben
            </Button>
          </div>
          {connectMethod === "qr" ? (
            <InstanceQrScanner
              key={scanRevision}
              onDetected={(value) => {
                setScannedInvite(value);
                setConnectMethod("link");
              }}
            />
          ) : (
            <PairingAddSurface
              key={connectMethod}
              initialInvite={scannedInvite}
              initialChoice={connectMethod === "manual" ? "manual" : "invite"}
              existingOnly
              onClose={() => setStep("choose")}
              onImported={chooseDiscovered}
              onBusyChange={onBusyChange}
            />
          )}
        </div>
      ) : null}
      {step === "select" ? instanceList : null}
    </div>
  );
}
