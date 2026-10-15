/**
 * Isolierte Fixture für Einstellungen › Sprachausgabe und Modelle › Anbieter
 * (Screenshots, kein Backend). Der Desktop-Bridge-Ersatz beantwortet
 * `speech.settings.*` aus einem Speicherzustand; `instance.*` scheitert wie auf
 * WELSCH mit `guest_failed`. Nichts verbindet sich irgendwohin.
 *
 * ?view=speech | models
 */
import {
  WorkjetGatewayAccountId,
  type WorkjetGatewayAccountSummary,
  type WorkjetGatewayApiKeyProvider,
  type WorkjetGatewayOauthProvider,
} from "@workjet/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { InstanceProviderSection } from "../components/settings/InstanceProviderSection";
import { InstanceSpeechSettings } from "../components/settings/SpeechSettingsPanel";
import { useInstanceGrokAccount } from "../components/settings/useInstanceGrokAccount";
import { useInstanceProviders } from "../components/settings/useInstanceProviders";
import type { WorkjetGatewayLoginState } from "../components/settings/WorkjetGatewayAccounts";
import { WorkjetModelsProviders } from "../components/settings/WorkjetModelsProviders";
import "../index.css";

const query = new URLSearchParams(window.location.search);
const INSTANCE = "managed:welsch";

const speech = {
  config: { synthesis: "runtime", transcription: "runtime", voice_id: null, rate: 1.15 } as {
    synthesis: "runtime" | "mistral" | "computer";
    transcription: "runtime" | "mistral" | "computer";
    voice_id: string | null;
    rate: number;
  },
  credential: query.get("speech") === "saved",
  ttsCheck: null as null | Record<string, unknown>,
  sttCheck: null as null | Record<string, unknown>,
};
const delay = <T,>(value: T, ms = 600) =>
  new Promise<T>((resolve) => window.setTimeout(() => resolve(value), ms));

function speechResponse(action: string, commandId: string, extra: Record<string, unknown> = {}) {
  return {
    _tag: "completed",
    response: {
      action,
      commandId,
      status: {
        config: speech.config,
        mistral_credential_present: speech.credential,
        mistral_voice_configured: speech.config.voice_id !== null,
        streaming_stt_selected: false,
        stt: "unknown",
        tts: "unknown",
      },
      ttsCheck: speech.ttsCheck,
      sttCheck: speech.sttCheck,
      ...extra,
    },
  };
}

async function requestProjectControl(_instanceId: string, request: Record<string, unknown>) {
  const action = String(request.action);
  const commandId = String(request.commandId);
  if (action.startsWith("instance.")) return delay({ _tag: "failed", code: "guest_failed" }, 300);
  if (action === "speech.settings.key") {
    const secret = String(request.secret);
    if (secret.trim() !== secret) return delay({ _tag: "failed", code: "guest_failed" });
    speech.credential = true;
    return delay(speechResponse(action, commandId));
  }
  if (action === "speech.settings.configure") {
    speech.config = request.config as typeof speech.config;
    return delay(speechResponse(action, commandId), 300);
  }
  if (action === "speech.settings.voices")
    return delay(
      speechResponse(action, commandId, {
        voices: [
          { id: "v-anna", name: "Anna (de)" },
          { id: "v-jonas", name: "Jonas (de)" },
        ],
      }),
      400,
    );
  if (action === "speech.settings.check") {
    speech.ttsCheck = {
      state: speech.credential && speech.config.synthesis === "mistral" ? "ok" : "error",
      checkedAt: "2026-10-15T19:20:00Z",
      latencyMs: speech.credential ? 412 : null,
      errorClass: speech.credential ? null : "missing_credential",
    };
    return delay(speechResponse(action, commandId), 1200);
  }
  if (action === "speech.settings.check.transcription") {
    speech.sttCheck = {
      state: "ok",
      checkedAt: "2026-10-15T19:20:00Z",
      latencyMs: 380,
      errorClass: null,
    };
    return delay(
      speechResponse(action, commandId, { transcript: "Die Sprachausgabe ist bereit." }),
      1200,
    );
  }
  return delay(speechResponse(action, commandId), 400);
}

(window as unknown as { desktopBridge: unknown }).desktopBridge = {
  ctox: { requestProjectControl },
};

function account(
  id: string,
  provider: WorkjetGatewayAccountSummary["provider"],
  label: string,
  modelIds: string[],
  credentialSuffix: string | null = null,
): WorkjetGatewayAccountSummary {
  return {
    id: WorkjetGatewayAccountId.make(id),
    provider,
    label,
    enabled: true,
    priority: 0,
    weight: 1,
    modelIds,
    credentialSuffix,
    ...(credentialSuffix ? { credentialKind: "api-key" as const } : {}),
  };
}

function ModelsView() {
  const [accounts, setAccounts] = useState<WorkjetGatewayAccountSummary[]>([
    account("a-claude", "claude", "michael@metric-space.ai", [
      "claude-opus-5-5",
      "claude-sonnet-5",
    ]),
    account("a-codex", "codex", "OpenAI 1", ["gpt-6-sol", "gpt-5.6-terra"]),
    account("a-zai", "zai", "Z.ai 1", ["glm-5.3-flash"], "9f2a"),
    account("a-minimax", "minimax", "MiniMax 1", ["MiniMax-M3"], "77c1"),
    account("a-kimi", "kimi", "Kimi 1", ["kimi-k3"], "b04e"),
  ]);
  const [login, setLogin] = useState<WorkjetGatewayLoginState>({ status: "idle" });
  const grok = useInstanceGrokAccount(INSTANCE, "Welsch");
  const providers = useInstanceProviders(INSTANCE);
  return (
    <WorkjetModelsProviders
      status={{
        schemaVersion: 1,
        phase: "ready",
        pid: 1,
        providerEndpoint: "http://127.0.0.1:8317",
        managementEndpoint: "http://127.0.0.1:8318",
        failureReason: null,
        configuredAccountCount: accounts.length,
        configuredModelCount: 8,
      }}
      catalog={{
        schemaVersion: 1,
        accounts,
        pools: [],
        routes: [],
        models: [],
        routingStrategy: "fill-first",
        providerPools: [],
        providerModels: [{ provider: "xai", modelIds: ["grok-4.7", "grok-4.6", "grok-code-fast"] }],
      }}
      isInitialLoading={false}
      isRefreshing={false}
      statusError={null}
      catalogError={null}
      isOperating={false}
      login={login}
      apiKey={{ status: "idle" }}
      mutationBusy={false}
      loginAccountId={null}
      accountErrors={{}}
      accountHealth={{}}
      modelChecks={[]}
      checksBusy={false}
      onRefresh={() => {}}
      onRetry={() => {}}
      onAddAccount={(provider: WorkjetGatewayOauthProvider) =>
        setLogin({
          status: "pending",
          provider,
          state: "fixture",
          authorizationUrl: "https://example.invalid/login",
        })
      }
      onCancelLogin={() => setLogin({ status: "idle" })}
      onAddApiKey={() => {}}
      onRemoveAccount={() => {}}
      onCheckModels={() => {}}
      onEditAccount={async () => true}
      onEditModels={async () => true}
      onDeleteAccount={async () => true}
      onRelogin={() => {}}
      onSaveApiKey={async (provider: WorkjetGatewayApiKeyProvider, _key: string, label: string) => {
        await delay(null);
        setAccounts((current) => [
          ...current,
          account(`a-${provider}-new`, provider, label, ["grok-4.7"], "k3y9"),
        ]);
        return true;
      }}
      instanceGrok={grok}
      nativeProviderRows={
        <InstanceProviderSection label="Welsch" grok={grok} providers={providers} />
      }
    />
  );
}

function App() {
  const view = query.get("view") ?? "speech";
  return (
    <div className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-4xl space-y-4">
        {view === "models" ? (
          <ModelsView />
        ) : (
          <InstanceSpeechSettings instanceId={INSTANCE} onUnsupported={() => {}} />
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
