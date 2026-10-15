/**
 * Isolierte Fixture für die Ruhezustände, wenn keine Instanz offen ist, den
 * Anmeldezustand nach Schlüsselverlust und die Modellwahl als Menü
 * (Screenshots, kein Backend, keine Verbindungen).
 * Ansicht per `?view=failed|connecting|select|leer|anmelden|modell`.
 */
import type {
  CtoxManagedInstance,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@workjet/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import {
  InstanceOnboardingView,
  WorkjetKeyRecoveryView,
} from "../components/ctox/InstanceOnboarding";
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import type { ProviderInstanceEntry } from "../providerInstances";
import "../index.css";

const view = new URLSearchParams(window.location.search).get("view") ?? "failed";

const instance = (id: string, displayName: string) =>
  ({
    id,
    source: "ctox_dev",
    displayName,
    status: "ready",
    healthSummary: { dataPlaneReady: false },
  }) as unknown as CtoxManagedInstance;
const instances = [
  instance("welsch", "welsch"),
  instance("thesen", "thesen"),
  instance("skf", "SKF"),
  instance("local", "Dieser Mac"),
];

const entry = (instanceId: string, driverKind: string, displayName: string) =>
  ({
    instanceId: instanceId as ProviderInstanceId,
    driverKind: driverKind as ProviderDriverKind,
    displayName,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: true,
    isAvailable: true,
    snapshot: {},
    models: [],
  }) as unknown as ProviderInstanceEntry;
const entries = [
  entry("codex", "codex", "Codex"),
  entry("claudeAgent", "claudeAgent", "Claude"),
  entry("grok", "grok", "Grok"),
];
const models = new Map<ProviderInstanceId, ReadonlyArray<{ slug: string; name: string }>>([
  [
    "codex" as ProviderInstanceId,
    [
      { slug: "gpt-6-sol", name: "GPT-6 Sol" },
      { slug: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    ],
  ],
  [
    "claudeAgent" as ProviderInstanceId,
    [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    ],
  ],
  ["grok" as ProviderInstanceId, [{ slug: "grok-4.7", name: "Grok 4.7" }]],
]);

function Fixture() {
  if (view === "anmelden") return <WorkjetKeyRecoveryView onLogin={() => {}} />;
  if (view === "modell")
    return (
      <div className="flex h-dvh items-end p-6">
        <ProviderModelPicker
          activeInstanceId={"claudeAgent" as ProviderInstanceId}
          model="claude-opus-5-5"
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={models}
          open
          onInstanceModelChange={() => {}}
        />
      </div>
    );
  const state =
    view === "connecting" || view === "select" || view === "failed" ? view : "create-or-connect";
  return (
    <div className="flex h-dvh">
      <InstanceOnboardingView
        state={state}
        instances={view === "leer" ? [] : instances}
        selectedId="welsch"
        onSelect={() => {}}
        onRetry={() => {}}
      />
    </div>
  );
}

const router = createRouter({
  routeTree: createRootRoute({ component: Fixture }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
