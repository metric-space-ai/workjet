/**
 * Isolierte Fixture für die Freigabe-Karten im Chat (Screenshots, kein Backend).
 * Feste Beispielanfragen der Instanz; Aktionen laufen gegen einen lokalen
 * Ersatz und verbinden sich nirgendwohin. Szene per `?scene=…`, Sprache per `?lang=en`.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";

import "../index.css";
import { PinnedRequestStack, type SessionUiRequest } from "../components/chat/SessionRequestCards";
import { CredentialCard } from "../components/toolhub/ToolhubCards";

const q = new URLSearchParams(location.search);
const scene = q.get("scene") ?? "credential";
const en = q.get("lang") === "en";
const t = (de: string, enText: string) => (en ? enText : de);
const now = Date.now() / 1000;

const pipedrive: SessionUiRequest = {
  id: "r1",
  kind: "credential",
  status: "open",
  toolkit: "pipedrive",
  title: { de: "Pipedrive API-Schlüssel", en: "Pipedrive API key" },
  message: t(
    "Pipedrive → Profil → Persönliche Einstellungen → API. Wird nur zum Lesen genutzt.",
    "Pipedrive → Profile → Personal preferences → API. Used for reading only.",
  ),
  fields: [{ name: "api_key", secret: true }],
  created_at: now - 300,
};
const zendesk: SessionUiRequest = {
  id: "r2",
  kind: "credential",
  status: "open",
  toolkit: "zendesk",
  title: { de: "Zendesk verbinden", en: "Connect Zendesk" },
  message: t(
    "Zendesk → Admin Center → Apps und Integrationen → API.",
    "Zendesk → Admin Center → Apps and integrations → API.",
  ),
  fields: [{ name: "api_key", secret: true }],
  params: [
    {
      key: "subdomain",
      label: { de: "Zendesk-Subdomain", en: "Zendesk subdomain" },
      help: {
        de: "Der Teil vor .zendesk.com, z. B. „acme“.",
        en: 'The part before .zendesk.com, e.g. "acme".',
      },
      placeholder: "acme",
      required: true,
    },
    {
      key: "email",
      label: { de: "E-Mail des API-Nutzers", en: "API user email" },
      placeholder: "agent@acme.de",
      required: true,
    },
  ],
  created_at: now - 200,
};
const linear: SessionUiRequest = {
  id: "r3",
  kind: "connect",
  status: "open",
  toolkit: "linear",
  message:
    "The product development system for teams and agents. Manage issues, projects and roadmaps.",
  created_at: now - 100,
};
const confirm: SessionUiRequest = {
  id: "r4",
  kind: "confirm",
  status: "open",
  toolkit: "hubspot",
  message: t("HubSpot: 3 Kontakte anlegen", "HubSpot: create 3 contacts"),
  created_at: now - 50,
};

const scenes: Record<string, SessionUiRequest[]> = {
  credential: [pipedrive],
  params: [zendesk],
  connect: [linear],
  connected: [{ ...linear, status: "done", resolved_at: now }],
  stack: [pipedrive, linear, confirm],
  "stack-open": [pipedrive, linear, confirm],
  error: [linear],
};

function Bubble({ me, children }: { me?: boolean; children: string }) {
  return (
    <div
      className={`max-w-[640px] rounded-2xl px-4 py-2.5 text-[14.5px] leading-relaxed ${me ? "self-end bg-violet-600 text-white" : "bg-card"}`}
    >
      {children}
    </div>
  );
}

function Fixture() {
  const [expanded, setExpanded] = useState(scene === "stack-open");
  const call = async () => {
    if (scene === "error") throw Object.assign(new Error("upstream_unreachable"), { status: 502 });
    return {};
  };
  if (scene === "store") {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-8">
        <h2 className="text-[18px] font-medium">Zendesk</h2>
        <CredentialCard
          t={t}
          appName="Zendesk"
          title={t("Zendesk API-Schlüssel", "Zendesk API key")}
          help={t(
            "Wird nur auf Welsch gespeichert und von allen Agenten der Instanz genutzt.",
            "Stored only on Welsch and used by all agents on the instance.",
          )}
          secrets={[{ name: "token", secret: true }]}
          params={zendesk.params ?? []}
          onSubmit={() => undefined}
        />
      </div>
    );
  }
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-end gap-3 overflow-hidden p-4">
        <Bubble me>
          {t(
            "biete mir mal testweise den Pipedrive-Adapter an.",
            "offer me the Pipedrive adapter as a test.",
          )}
        </Bubble>
        <Bubble>
          {t(
            "Gern. Gib unten deinen Schlüssel ein; ich prüfe dann mit Leseaktionen, ob der Adapter deine echten Deals abrufen kann.",
            "Sure. Enter your key below; I'll then check with read-only actions that the adapter can fetch your real deals.",
          )}
        </Bubble>
      </div>
      <PinnedRequestStack
        requests={scenes[scene] ?? []}
        expanded={expanded}
        setExpanded={setExpanded}
        t={t}
        instance="fixture"
        call={call}
        onChanged={async () => undefined}
      />
      <div className="mx-auto mb-4 w-full max-w-3xl px-1">
        <div className="rounded-2xl border border-border bg-card px-4 py-3 text-[14px] text-muted-foreground">
          {t("Nachricht an Workjet …", "Message Workjet …")}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
// Dunkles App-Schema wie im Chat; `?theme=light` für die helle Variante.
const dark = q.get("theme") !== "light";
window.setTimeout(() => document.documentElement.classList.toggle("dark", dark), 0);
