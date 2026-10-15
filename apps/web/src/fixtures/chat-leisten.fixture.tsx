/** Loopback-only interaction fixture; no instance, model or customer data. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Schema } from "effect";
import { ArrowUpIcon } from "lucide-react";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkjetComputerId,
  WorkjetThreadGoal,
  WorkjetWorkerProfile,
  type WorkjetComputer,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import { ComposerBar } from "../components/chat/ComposerBar";
import {
  ComposerWorkerControl,
  ComposerWorkerMenuItems,
} from "../components/chat/ComposerWorkerControl";
import {
  ComposerComputerMenuItems,
  ComposerHarnessMenuItems,
  ComposerManualTargetControls,
} from "../components/chat/ComposerWorkjetTargetControls";
import { NativeSupervisorRouteControlsView } from "../components/chat/NativeSupervisorRouteControls";
import { PersistentWorkerGoal } from "../components/PersistentWorkerGoal";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import "../index.css";

if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  throw new Error("Chat-Leisten fixture requires a loopback development server.");
}

const envLocal = EnvironmentId.make("environment-local");
const mac: WorkjetComputer = {
  id: WorkjetComputerId.make("mac-local"),
  label: "MacBook-Pro-von-Michael",
  environmentId: envLocal,
  presentationKind: "local",
  harnesses: [],
};
const gpu: WorkjetComputer = {
  id: WorkjetComputerId.make("gpu3"),
  label: "gpu3",
  environmentId: EnvironmentId.make("environment-gpu3"),
  presentationKind: "ssh",
  harnesses: [],
};
const worker = Schema.decodeUnknownSync(WorkjetWorkerProfile)({
  id: "supervisor-luma",
  name: "Molecularity Supervisor",
  computerId: mac.id,
  harness: "codex-cli",
  llmRouteId: "codex-personal",
  modelId: "gpt-6.1-sol",
  reasoning: "automatic",
});
const secondWorker = Schema.decodeUnknownSync(WorkjetWorkerProfile)({
  id: "review-luma",
  name: "Review-Preset",
  computerId: gpu.id,
  harness: "claude-code",
  llmRouteId: "claude-personal",
  modelId: "claude-opus-5-5",
  reasoning: "automatic",
});
const manualProfile = Schema.decodeUnknownSync(WorkjetWorkerProfile)({
  id: "supervisor-manual:fixture-project:codex",
  name: "Manuell",
  computerId: mac.id,
  harness: "codex-cli",
  llmRouteId: "codex-personal",
  modelId: "gpt-6.1-sol",
  reasoning: "automatic",
});
const models = [{ id: "gpt-6.1-sol", displayName: "gpt-6.1-sol", providers: [], accountIds: [] }];
const noop = () => undefined;
const section = new URLSearchParams(location.search).get("s") ?? "01";

function Bar({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section aria-label={label} className="mx-auto w-full max-w-3xl p-3">
      <p className="mb-1 text-xs text-muted-foreground">{label}</p>
      <div className="rounded-2xl border bg-card p-2">
        <div className="px-1 py-2 text-sm text-muted-foreground">Nachricht …</div>
        <ComposerBar
          attachments={null}
          settings={null}
          dictation={null}
          worker={<>{children}</>}
          actions={
            <button
              type="button"
              aria-label="Senden"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
            >
              <ArrowUpIcon className="size-4" aria-hidden="true" />
            </button>
          }
        />
      </div>
    </section>
  );
}

/** 01: Supervisor-Leiste und normale Chat-Leiste, beide mit echten Werten. */
function BothBars() {
  return (
    <div data-fixture="01-beide-leisten">
      <Bar label="Supervisor">
        <NativeSupervisorRouteControlsView
          projectId="fixture-project"
          selected={manualProfile}
          profiles={[manualProfile, worker, secondWorker]}
          computers={[mac, gpu]}
          models={models}
          environmentId={envLocal}
          selectedComputerId={mac.id}
          disabled={false}
          unavailableReason={null}
          onSelectWorker={noop}
          onSelectManual={noop}
          onError={noop}
          onConfigureWorkers={noop}
          onAddComputer={noop}
          onSetupHarness={noop}
        />
      </Bar>
      <Bar label="Chat">
        <ComposerWorkerControl
          workers={[worker, secondWorker]}
          selectedWorkerId={null}
          onSelectWorker={noop}
          onOpenWorkjetSettings={noop}
        />
        <ComposerManualTargetControls
          configuredInstanceIds={new Set(["claudeAgent", "codex"])}
          selectedHarness="codex-cli"
          onSelectHarness={noop}
          modelSource="configured"
          models={models}
          modelsUnavailableReason={null}
          selectedModelId="gpt-6.1-sol"
          onSelectModel={noop}
          onSetupHarness={noop}
        />
      </Bar>
    </div>
  );
}

/** 02: Luma-Menü bei gescheitertem Laden — die zuletzt bekannte Liste bleibt. */
function LumaMenu() {
  return (
    <div data-fixture="02-luma-menue" className="p-6">
      <Menu defaultOpen>
        <MenuTrigger className="rounded-md border px-2 py-1 text-sm">Preset</MenuTrigger>
        <MenuPopup align="start" side="bottom" className="min-w-56 max-w-80">
          <ComposerWorkerMenuItems
            workers={[worker, secondWorker]}
            selectedWorkerId={worker.id}
            disabled={false}
            onSelectWorker={noop}
            onOpenWorkjetSettings={noop}
          />
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** 03: Rechner-Menü bei Timeout — der eigene Mac bleibt verfügbar. */
function ComputerMenu() {
  return (
    <div data-fixture="03-rechner-menue" className="p-6">
      <Menu defaultOpen>
        <MenuTrigger className="rounded-md border px-2 py-1 text-sm">Rechner</MenuTrigger>
        <MenuPopup align="start" side="bottom" className="min-w-56 max-w-80">
          <ComposerComputerMenuItems
            computers={[mac, gpu]}
            computerAvailability={{
              [mac.id]: {
                status: "Getrennt",
                reason: "Die Instanz hat nicht rechtzeitig geantwortet.",
              },
              [gpu.id]: { status: "Offline", reason: "Request timed out" },
            }}
            selectedComputerId={mac.id}
            activeEnvironmentId={envLocal}
            selectableEnvironmentIds={[envLocal, gpu.environmentId]}
            disabledReason={null}
            mismatchNote={null}
            onSelectComputer={noop}
            onAddComputer={noop}
          />
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** 04: Harness-Menü — fehlende Installationen bieten „Einrichten“. */
function HarnessMenu() {
  return (
    <div data-fixture="04-harness-menue" className="p-6">
      <Menu defaultOpen>
        <MenuTrigger className="rounded-md border px-2 py-1 text-sm">Harness</MenuTrigger>
        <MenuPopup align="start" side="bottom" className="min-w-48 max-w-72">
          <ComposerHarnessMenuItems
            configuredInstanceIds={new Set(["claudeAgent"])}
            selectedHarness="claude-code"
            onSelectHarness={noop}
            onSetupHarness={noop}
          />
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** 05: Luma-Chat mit einzeiligem Ziel-Kopf. */
function GoalChat() {
  const goal = Schema.decodeUnknownSync(WorkjetThreadGoal)({
    objective:
      "Die Molecularity-Rendering-Pipeline gegen den echten Benchmark vermessen und jeden Regressionstreffer mit Beleg im Verlauf ablegen, damit das Team ohne Nachfragen weiterarbeiten kann",
    status: "active",
    revision: 4,
    continuationCount: 0,
    lastCompletedTurnId: null,
    pendingContinuation: null,
    reason: null,
    updatedAt: "2026-10-13T15:05:00Z",
  });
  const config: WorkjetThreadConfig = {
    ...DEFAULT_WORKJET_THREAD_CONFIG,
    team: {
      role: "specialist",
      domain: "rendering",
      projectId: ProjectId.make("Molecularity"),
      threadId: ThreadId.make("rendering-parent"),
      parentThreadId: ThreadId.make("supervisor"),
      goal: goal.objective,
      createdAt: goal.updatedAt,
    },
    goal,
  };
  return (
    <div data-fixture="05-ziel-kopf" className="mx-auto w-full max-w-3xl">
      <PersistentWorkerGoal config={config} onChangeGoal={async () => true} />
      <div className="space-y-3 p-4 text-sm">
        <p className="ml-auto max-w-[85%] rounded-xl bg-muted/50 px-4 py-3">
          Bitte weiterarbeiten.
        </p>
        <p className="max-w-[85%] rounded-xl border px-4 py-3 text-muted-foreground">
          Ich messe weiter und lege Belege ab.
        </p>
      </div>
    </div>
  );
}

/** 06: Kopfzeile ohne Warte-Pille (Diagnose-Chip nur im Entwicklermodus). */
function HeaderClean() {
  return (
    <header
      data-fixture="06-kopfzeile"
      className="flex h-10 items-center gap-2 border-b border-border px-3"
    >
      <span className="text-sm font-medium">Molecularity</span>
      <span className="min-w-0 flex-1" />
      <span className="text-xs text-muted-foreground">Workjet 0.0.97</span>
    </header>
  );
}

/** Klickprüfung: Senden wirkt optimistisch, auch wenn die Antwort hängt. */
function OptimisticSend() {
  const [sent, setSent] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState("");
  const [hanging, setHanging] = useState(false);
  return (
    <div data-fixture="07-optimistisch" className="mx-auto w-full max-w-3xl p-3">
      <div className="space-y-3 p-2 text-sm" aria-live="polite">
        {sent.map((text) => (
          <p key={text} className="ml-auto max-w-[85%] rounded-xl bg-muted/50 px-4 py-3">
            {text}
          </p>
        ))}
        {hanging ? <p className="text-xs text-muted-foreground">Antwort lädt …</p> : null}
      </div>
      <form
        aria-label="Supervisor-Leiste"
        className="rounded-2xl border bg-card p-2"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (text === "") return;
          // Die Antwort hängt; die Nachricht erscheint trotzdem sofort.
          setHanging(true);
          setSent((current) => [...current, text]);
          setDraft("");
        }}
      >
        <textarea
          aria-label="Nachricht an Supervisor"
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="w-full resize-none bg-transparent px-1 py-2 text-sm outline-none"
        />
        <ComposerBar
          attachments={null}
          settings={null}
          dictation={null}
          worker={
            <NativeSupervisorRouteControlsView
              projectId="fixture-project"
              selected={manualProfile}
              profiles={[manualProfile, worker]}
              computers={[mac, gpu]}
              models={models}
              environmentId={envLocal}
              selectedComputerId={mac.id}
              disabled={false}
              unavailableReason={null}
              onSelectWorker={noop}
              onSelectManual={noop}
              onError={noop}
              onConfigureWorkers={noop}
              onAddComputer={noop}
              onSetupHarness={noop}
            />
          }
          actions={
            <button
              type="submit"
              aria-label="An Supervisor senden"
              disabled={draft.trim() === ""}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
            >
              <ArrowUpIcon className="size-4" aria-hidden="true" />
            </button>
          }
        />
      </form>
    </div>
  );
}

const view =
  section === "01" ? (
    <BothBars />
  ) : section === "02" ? (
    <LumaMenu />
  ) : section === "03" ? (
    <ComputerMenu />
  ) : section === "04" ? (
    <HarnessMenu />
  ) : section === "05" ? (
    <GoalChat />
  ) : section === "06" ? (
    <HeaderClean />
  ) : (
    <OptimisticSend />
  );

createRoot(document.getElementById("root")!).render(view);
