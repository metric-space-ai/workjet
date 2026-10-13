// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Einstellungen → Schnittstellen: Store für CTOX-Toolhub-Connectors.
 *
 * Wie Cursor/Claude-Connectors: Kachel → „Hinzufügen“ → die Anmeldeseite des
 * Anbieters öffnet sich in einem App-Fenster → fertig. CTOX ist intern
 * MCP-Client der offiziellen Remote-MCP-Server; Tokens liegen auf der
 * CTOX-Instanz (secrets.rs), nie im Renderer.
 */
import {
  CheckCircle2Icon,
  Loader2Icon,
  PlugIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useUiText } from "../../hooks/useUiText";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export interface ToolhubConnector {
  readonly slug: string;
  readonly name: string;
  readonly serverUrl: string;
  readonly description: { readonly de: string; readonly en: string };
  /** dynamic = RFC 7591 DCR (zero config); preregistered = needs a one-time OAuth client. */
  readonly registration: "dynamic" | "preregistered";
  readonly monogram: string;
  readonly color: string;
}

/** Mirrors `ctox_toolhub::remote_mcp::registry()` until the instance serves it. */
export const TOOLHUB_CONNECTORS: ReadonlyArray<ToolhubConnector> = [
  {
    slug: "cloudflare",
    name: "Cloudflare",
    serverUrl: "https://mcp.cloudflare.com/mcp",
    description: {
      de: "Zonen, DNS, Workers, R2 und mehr über den offiziellen Cloudflare-MCP-Server.",
      en: "Zones, DNS, Workers, R2 and more via the official Cloudflare MCP server.",
    },
    registration: "dynamic",
    monogram: "CF",
    color: "#f38020",
  },
  {
    slug: "cloudflare-bindings",
    name: "Cloudflare Workers Bindings",
    serverUrl: "https://bindings.mcp.cloudflare.com/mcp",
    description: {
      de: "Workers, KV, R2, D1 und Hyperdrive verwalten.",
      en: "Manage Workers, KV, R2, D1 and Hyperdrive.",
    },
    registration: "dynamic",
    monogram: "W",
    color: "#f6821f",
  },
  {
    slug: "vercel",
    name: "Vercel",
    serverUrl: "https://mcp.vercel.com",
    description: {
      de: "Projekte, Deployments, Logs und Doku auf Vercel.",
      en: "Projects, deployments, logs and docs on Vercel.",
    },
    registration: "dynamic",
    monogram: "▲",
    color: "#000000",
  },
  {
    slug: "slack",
    name: "Slack",
    serverUrl: "https://mcp.slack.com/mcp",
    description: {
      de: "Nachrichten, Kanäle und Suche in Slack.",
      en: "Messages, channels and search in Slack.",
    },
    registration: "preregistered",
    monogram: "S",
    color: "#4a154b",
  },
  {
    slug: "gmail",
    name: "Gmail",
    serverUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    description: {
      de: "E-Mails in Gmail suchen, lesen und entwerfen.",
      en: "Search, read and draft Gmail messages.",
    },
    registration: "preregistered",
    monogram: "G",
    color: "#ea4335",
  },
];

type ConnectionState =
  | { readonly status: "idle" }
  | { readonly status: "connecting" }
  | { readonly status: "connected"; readonly at: number }
  | { readonly status: "failed"; readonly message: string };

const STORAGE_KEY = "workjet.toolhub.connections.v1";

function loadConnected(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function saveConnected(value: Record<string, number>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Speicher voll/gesperrt: Zustand bleibt nur für diese Sitzung.
  }
}

function ConnectorLogo({ connector }: { connector: ToolhubConnector }) {
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold text-white"
      style={{ backgroundColor: connector.color }}
    >
      {connector.monogram}
    </span>
  );
}

export function IntegrationsSettingsPanel() {
  const t = useUiText();
  const [states, setStates] = useState<Record<string, ConnectionState>>({});
  const [removed, setRemoved] = useState<{ slug: string; at: number } | null>(null);

  useEffect(() => {
    const connected = loadConnected();
    setStates(
      Object.fromEntries(
        Object.entries(connected).map(([slug, at]) => [slug, { status: "connected", at }]),
      ),
    );
  }, []);

  useEffect(() => {
    if (removed === null) return;
    const timer = window.setTimeout(() => setRemoved(null), 8000);
    return () => window.clearTimeout(timer);
  }, [removed]);

  const persist = useCallback((next: Record<string, ConnectionState>) => {
    const connected: Record<string, number> = {};
    for (const [slug, state] of Object.entries(next)) {
      if (state.status === "connected") connected[slug] = state.at;
    }
    saveConnected(connected);
  }, []);

  const update = useCallback(
    (slug: string, state: ConnectionState) => {
      setStates((current) => {
        const next = { ...current, [slug]: state };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  const canConnectInApp = typeof bridge?.toolhubConnect === "function";

  const add = async (connector: ToolhubConnector) => {
    if (!bridge?.toolhubConnect) return;
    update(connector.slug, { status: "connecting" });
    const result = await bridge.toolhubConnect({
      server: connector.slug,
      serverUrl: connector.serverUrl,
    });
    if (result._tag === "authorized")
      update(connector.slug, { status: "connected", at: Date.now() });
    else if (result._tag === "cancelled") update(connector.slug, { status: "idle" });
    else update(connector.slug, { status: "failed", message: result.message ?? "" });
  };

  const remove = (connector: ToolhubConnector) => {
    const state = states[connector.slug];
    update(connector.slug, { status: "idle" });
    if (state?.status === "connected") setRemoved({ slug: connector.slug, at: state.at });
  };

  const undoRemove = () => {
    if (removed === null) return;
    update(removed.slug, { status: "connected", at: removed.at });
    setRemoved(null);
  };

  const installed = TOOLHUB_CONNECTORS.filter((c) => states[c.slug]?.status === "connected");

  return (
    <SettingsPageContainer
      title={t("Schnittstellen", "Integrations")}
      titleIcon={<PlugIcon className="size-4" />}
    >
      <p className="px-3 text-[13px] text-muted-foreground sm:px-4">
        {t(
          "Verbinde Dienste, die Agenten dieser Instanz über „ctox toolhub“ nutzen dürfen. Die Anmeldung erfolgt direkt beim Anbieter in einem App-Fenster; Zugangsdaten bleiben auf der CTOX-Instanz.",
          "Connect services that agents on this instance can use via “ctox toolhub”. You sign in directly with the provider in an app window; credentials stay on the CTOX instance.",
        )}
      </p>

      {removed !== null ? (
        <div
          role="status"
          className="mx-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[13px] sm:mx-4"
        >
          <span>
            {t("Verbindung entfernt:", "Connection removed:")}{" "}
            {TOOLHUB_CONNECTORS.find((c) => c.slug === removed.slug)?.name}
          </span>
          <Button size="xs" variant="outline" onClick={undoRemove}>
            <RotateCcwIcon className="me-1 size-3.5" />
            {t("Rückgängig", "Undo")}
          </Button>
        </div>
      ) : null}

      <SettingsSection id="integrations-installed" title={t("Installiert", "Installed")}>
        {installed.length === 0 ? (
          <SettingsRow
            title={
              <span className="text-muted-foreground">
                {t("Noch keine Schnittstelle verbunden.", "No integration connected yet.")}
              </span>
            }
          />
        ) : (
          installed.map((connector) => (
            <SettingsRow
              key={connector.slug}
              title={
                <span className="flex items-center gap-3">
                  <ConnectorLogo connector={connector} />
                  <span className="flex flex-col">
                    <span className="font-medium">{connector.name}</span>
                    <span className="text-[12px] text-muted-foreground">
                      {t("Agenten nutzen:", "Agents use:")}{" "}
                      <code>ctox toolhub exec {connector.slug}.&lt;tool&gt;</code>
                    </span>
                  </span>
                </span>
              }
              status={
                <Badge variant="success">
                  <CheckCircle2Icon className="me-1 size-3" />
                  {t("Verbunden", "Connected")}
                </Badge>
              }
              control={
                <Button size="xs" variant="outline" onClick={() => remove(connector)}>
                  {t("Entfernen", "Remove")}
                </Button>
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection id="integrations-store" title={t("Verfügbar", "Available")}>
        <div className="grid grid-cols-1 gap-3 px-3 pb-2 sm:grid-cols-2 sm:px-4 xl:grid-cols-3">
          {TOOLHUB_CONNECTORS.map((connector) => {
            const state = states[connector.slug] ?? { status: "idle" };
            const needsClient = connector.registration === "preregistered";
            return (
              <div
                key={connector.slug}
                data-toolhub-connector={connector.slug}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3"
              >
                <div className="flex items-start gap-3">
                  <ConnectorLogo connector={connector} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{connector.name}</span>
                      <Badge variant="outline">MCP</Badge>
                    </div>
                    <p className="mt-1 text-[12.5px] text-muted-foreground">
                      {t(connector.description.de, connector.description.en)}
                    </p>
                  </div>
                </div>
                {needsClient ? (
                  <p className="text-[12px] text-muted-foreground">
                    {t(
                      "Anbieter ohne automatische Registrierung – einmalige Einrichtung durch den Instanz-Admin nötig.",
                      "Provider has no automatic registration – one-time setup by the instance admin required.",
                    )}
                  </p>
                ) : null}
                {state.status === "failed" ? (
                  <p role="alert" className="flex items-start gap-1.5 text-[12px] text-destructive">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                    {state.message || t("Verbindung fehlgeschlagen.", "Connection failed.")}
                  </p>
                ) : null}
                <div className="mt-auto flex items-center justify-end gap-2">
                  {state.status === "connected" ? (
                    <Badge variant="success">
                      <CheckCircle2Icon className="me-1 size-3" />
                      {t("Verbunden", "Connected")}
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      data-workjet-action={`integrations.add.${connector.slug}`}
                      disabled={!canConnectInApp || needsClient || state.status === "connecting"}
                      onClick={() => void add(connector)}
                    >
                      {state.status === "connecting" ? (
                        <Loader2Icon className="me-1 size-3.5 animate-spin" />
                      ) : null}
                      {state.status === "connecting"
                        ? t("Anmeldung läuft …", "Signing in …")
                        : t("Hinzufügen", "Add")}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {!canConnectInApp ? (
          <p className="px-3 text-[12px] text-muted-foreground sm:px-4">
            {t(
              "Verbinden ist in der Workjet-Desktop-App möglich.",
              "Connecting is available in the Workjet desktop app.",
            )}
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
