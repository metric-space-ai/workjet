/**
 * Loopback-only composer fixture (Review-Fix R1); no instance, model or
 * customer data. Query: ?send=1 (An Luma senden), ?banner=1 (Banner mit
 * langer Zeile), ?tools=all (alle Werkzeuge an, Instanzwahl sichtbar).
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  EnvironmentId,
  WorkjetComputerId,
  WorkjetConnectionId,
  WorkjetLlmRouteId,
  WorkjetMeshWorkspaceId,
  WorkjetWorkerProfileId,
  type WorkjetHarness,
  type WorkjetMeshRoster,
  type WorkjetWorkerProfile,
} from "@workjet/contracts";
import { GitBranchIcon, PaperclipIcon, ArrowUpIcon, MicIcon } from "lucide-react";

import "../index.css";
import { ComposerBar } from "../components/chat/ComposerBar";
import { ComposerWorkerControl } from "../components/chat/ComposerWorkerControl";
import {
  ComposerComputerControl,
  ComposerManualTargetControls,
  ComposerSystemPromptControl,
} from "../components/chat/ComposerWorkjetTargetControls";
import { CompactComposerControlsMenu } from "../components/chat/CompactComposerControlsMenu";
import { WorkjetCapabilityMenu } from "../components/chat/WorkjetCapabilityMenu";
import {
  EMPTY_WORKJET_SEND_DRAFT,
  WorkjetSendToWorkerMenuItem,
  WorkjetSendToWorkerPanel,
  type WorkjetSendDraft,
} from "../components/chat/WorkjetSendToWorkerPanel";
import { ContextWindowMeter } from "../components/chat/ContextWindowMeter";
import { ExpandedImageInline } from "../components/chat/ExpandedImageInline";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";

if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  throw new Error("Composer fixture requires a loopback development server.");
}

const envA = EnvironmentId.make("environment-macbook");
const envB = EnvironmentId.make("environment-gpu3");
const envC = EnvironmentId.make("environment-gpu1");
const workers: WorkjetWorkerProfile[] = [
  {
    id: WorkjetWorkerProfileId.make("sol"),
    name: "Sol · Completion",
    computerId: WorkjetComputerId.make("mac"),
    harness: "claude-code",
    llmRouteId: WorkjetLlmRouteId.make("openai"),
    modelId: "gpt-6-sol",
    reasoning: "high",
    role: "standard",
    capabilityIds: [],
    capabilityBindings: [],
  },
  {
    id: WorkjetWorkerProfileId.make("kimi"),
    name: "Kimi · Review",
    computerId: WorkjetComputerId.make("mac"),
    harness: "codex-cli",
    llmRouteId: WorkjetLlmRouteId.make("kimi"),
    modelId: "kimi-k3",
    reasoning: "high",
    role: "standard",
    capabilityIds: [],
    capabilityBindings: [],
  },
];
const computers = [
  {
    id: WorkjetComputerId.make("mac"),
    label: "MacBook Pro",
    environmentId: envA,
    presentationKind: "local",
    harnesses: [],
  },
  {
    id: WorkjetComputerId.make("gpu3"),
    label: "gpu3-a4500",
    environmentId: envB,
    presentationKind: "ssh",
    harnesses: [],
  },
  {
    id: WorkjetComputerId.make("gpu1"),
    label: "gpu1-a6000",
    environmentId: envC,
    presentationKind: "tailscale",
    harnesses: [],
  },
] as const;
const models = [
  {
    id: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    providers: ["claude" as const],
    accountIds: [],
  },
  { id: "gpt-6-sol", displayName: "GPT-6 Sol", providers: ["codex" as const], accountIds: [] },
  { id: "grok-4.7", displayName: "Grok 4.7", providers: ["xai" as const], accountIds: [] },
  { id: "kimi-k3", displayName: "Kimi K3", providers: ["kimi" as const], accountIds: [] },
];
const roster: WorkjetMeshRoster = {
  schemaVersion: 1,
  local: {
    schemaVersion: 1,
    workspaceId: WorkjetMeshWorkspaceId.make("local"),
    environmentId: envA,
  },
  peers: [
    {
      schemaVersion: 1,
      workspaceId: WorkjetMeshWorkspaceId.make("peer"),
      environmentId: EnvironmentId.make("a1b2c3d4e5f6"),
      firstSeenAt: "2026-10-01T09:00:00.000Z",
      sealedDeliveryReady: true,
      binding: "self-signed",
    },
  ],
  truncated: false,
};
const connections = [
  {
    connectionId: WorkjetConnectionId.make("ctox-dev:welsch"),
    instanceId: "welsch.ctox.dev",
    displayName: "welsch",
    source: "ctox_dev" as const,
    status: "ready" as const,
    reason: null,
  },
  {
    connectionId: WorkjetConnectionId.make("ctox-dev:thesen"),
    instanceId: "thesen.ctox.dev",
    displayName: "thesen",
    source: "ctox_dev" as const,
    status: "offline" as const,
    reason: null,
  },
];
const params = new URLSearchParams(location.search);
const allTools = params.get("tools") === "all";
const showBanner = params.get("banner") === "1";
const showSend = params.get("send") === "1";
const showImage = params.get("image") === "1";
const imageSvg = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#1e293b"/><text x="80" y="160" font-size="96" fill="#e2e8f0" font-family="sans-serif">Screenshot 1600×900</text></svg>',
)}`;

function Fixture() {
  const [workerId, setWorkerId] = useState<string | null>(null);
  const [harness, setHarness] = useState<WorkjetHarness>("claude-code");
  const [model, setModel] = useState("claude-opus-5-5");
  const [computerId, setComputerId] = useState("mac");
  const [tools, setTools] = useState<string[]>(
    allTools ? ["greppy", "web-search", "decision-hub", "ctox-business-os"] : ["greppy"],
  );
  const [decisionHubId, setDecisionHubId] = useState<string>("ctox-dev:welsch");
  const [ctoxId, setCtoxId] = useState<string>("ctox-dev:welsch");
  const [orchestrator, setOrchestrator] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [sendOpen, setSendOpen] = useState(showSend);
  const [sendDraft, setSendDraft] = useState<WorkjetSendDraft>({
    ...EMPTY_WORKJET_SEND_DRAFT,
    targetThreadId: "t-review",
    message: showSend ? "Bitte die Tests in apps/web prüfen." : "",
  });
  const [bannerOpen, setBannerOpen] = useState(showBanner);
  const [imageOpen, setImageOpen] = useState(showImage);
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 text-[13.5px]">
          <div className="self-end rounded-2xl bg-secondary px-4 py-2">
            Kannst du den Composer prüfen?
          </div>
          <div className="text-muted-foreground">
            Ja. Harness, Modell und Rechner sind jetzt schlichte Dropdowns.
          </div>
        </div>
      </div>
      <div className="px-3 pb-4 sm:px-4">
        {bannerOpen ? (
          <Banner
            icon={GitBranchIcon}
            className="mx-auto mb-2 w-full max-w-5xl"
            action={{ label: "Wechseln", onClick: () => setBannerOpen(false) }}
            secondaryAction={{ label: "Abbrechen", onClick: () => setBannerOpen(false) }}
          >
            Ungesicherte Änderungen gehen beim Wechsel mit nach{" "}
            <code className="font-medium">feature/drei-orte-composer-review</code>
          </Banner>
        ) : null}
        {imageOpen ? (
          <ExpandedImageInline
            preview={{ images: [{ src: imageSvg, name: "bildschirmfoto.png" }], index: 0 }}
            onClose={() => setImageOpen(false)}
          />
        ) : null}
        {sendOpen ? (
          <div className="mx-auto mb-2 w-full max-w-5xl">
            <WorkjetSendToWorkerPanel
              draft={sendDraft}
              threads={[
                { threadId: "t-review", title: "Kimi · Review" },
                { threadId: "t-sol", title: "Sol · Umsetzung Composer" },
              ]}
              roster={roster}
              computerLabels={{ "environment-gpu3": "gpu3-a4500" }}
              busy={false}
              outcome={null}
              onDraftChange={setSendDraft}
              onSubmit={() => undefined}
              onClose={() => setSendOpen(false)}
            />
          </div>
        ) : null}
        <form className="mx-auto w-full max-w-5xl" onSubmit={(event) => event.preventDefault()}>
          <div className="rounded-[22px] border bg-card p-px">
            <div className="rounded-[20px]">
              <textarea
                aria-label="Nachricht an den Chat"
                className="block w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[14px] outline-none"
                rows={2}
                placeholder="Nachricht schreiben…"
              />
              <div
                data-chat-composer-footer="true"
                className="flex min-w-0 items-end gap-2 px-3 pb-3 sm:px-4"
              >
                <ComposerBar
                  attachments={
                    <Button type="button" size="icon-sm" variant="ghost" aria-label="Anhängen">
                      <PaperclipIcon />
                    </Button>
                  }
                  worker={
                    <ComposerWorkerControl
                      workers={workers}
                      selectedWorkerId={workerId}
                      onSelectWorker={setWorkerId}
                      onOpenWorkjetSettings={() => undefined}
                    />
                  }
                  status={
                    <ContextWindowMeter
                      usage={
                        {
                          usedTokens: 84_000,
                          maxTokens: 200_000,
                          totalProcessedTokens: 412_000,
                          compactsAutomatically: true,
                          remainingTokens: 116_000,
                          usedPercentage: 42,
                          remainingPercentage: 58,
                          updatedAt: "2026-10-11T21:00:00.000Z",
                        } as never
                      }
                      providerDisplayName="Claude"
                    />
                  }
                  manual={
                    workerId === null ? (
                      <>
                        <ComposerManualTargetControls
                          configuredInstanceIds={new Set(["claudeAgent", "codex", "opencode"])}
                          selectedHarness={harness}
                          onSelectHarness={setHarness}
                          models={models}
                          modelsUnavailableReason={null}
                          selectedModelId={model}
                          onSelectModel={setModel}
                        />
                        <ComposerComputerControl
                          computers={computers}
                          computerAvailability={{
                            mac: { status: "verbunden", reason: null },
                            gpu3: { status: "verbunden", reason: null },
                            gpu1: { status: "getrennt", reason: "getrennt" },
                          }}
                          selectedComputerId={computerId}
                          activeEnvironmentId={envA}
                          selectableEnvironmentIds={[envA, envB]}
                          disabledReason={null}
                          mismatchNote={null}
                          onSelectComputer={setComputerId}
                          onAddComputer={() => undefined}
                        />
                      </>
                    ) : null
                  }
                  settings={
                    <CompactComposerControlsMenu
                      interactionMode="default"
                      showInteractionModeToggle
                      onToggleInteractionMode={() => undefined}
                      extraMenuContent={
                        <WorkjetSendToWorkerMenuItem onOpen={() => setSendOpen(true)} />
                      }
                      systemPromptMenuContent={
                        <ComposerSystemPromptControl
                          value={prompt}
                          busy={false}
                          disabled={false}
                          draftPending
                          onApply={setPrompt}
                        />
                      }
                      workjetMenuContent={
                        <WorkjetCapabilityMenu
                          compact
                          greppyEnabled={tools.includes("greppy")}
                          busy={false}
                          onGreppyEnabledChange={() => undefined}
                          enabledCapabilityIds={tools}
                          onCapabilityEnabledChange={(id, enabled) =>
                            setTools((current) =>
                              enabled
                                ? [...new Set([...current, id])]
                                : current.filter((entry) => entry !== id),
                            )
                          }
                          decisionHubConnections={connections}
                          decisionHubConnectionId={decisionHubId}
                          onDecisionHubConnectionChange={setDecisionHubId}
                          ctoxBusinessOsConnections={connections}
                          ctoxBusinessOsConnectionId={ctoxId}
                          onCtoxBusinessOsConnectionChange={setCtoxId}
                          workjetRole={orchestrator ? "orchestrator" : "standard"}
                          onWorkjetRoleChange={(role) => setOrchestrator(role === "orchestrator")}
                        />
                      }
                    />
                  }
                  dictation={
                    <Button type="button" size="icon-sm" variant="ghost" aria-label="Diktieren">
                      <MicIcon />
                    </Button>
                  }
                  actions={
                    <Button type="submit" size="icon-sm" aria-label="Senden">
                      <ArrowUpIcon />
                    </Button>
                  }
                />
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
