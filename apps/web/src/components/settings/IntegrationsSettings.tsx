// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Einstellungen → Schnittstellen: Store für CTOX-Toolhub-Adapter.
 *
 * Zustand kommt immer von der CTOX-Instanz (`/api/business-os/toolhub/*` über
 * den angemeldeten Guest). Die Instanz besitzt Registrierung, Rückleitung und
 * Tokens; die App öffnet nur die Anmelde-URL, die die Instanz ausgibt, oder
 * übergibt ein Token direkt an die Instanz.
 */
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  Loader2Icon,
  PlugIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useUiText } from "../../hooks/useUiText";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type Kind = "mcp" | "native";

export interface ToolhubConnector {
  readonly slug: string;
  readonly name: string;
  readonly kind: Kind;
  readonly description: { readonly de: string; readonly en: string };
  readonly monogram: string;
  readonly color: string;
  /** Native adapters: how the instance gets its credential. */
  readonly tokenHint?: { readonly de: string; readonly en: string };
}

export const TOOLHUB_CONNECTORS: ReadonlyArray<ToolhubConnector> = [
  {
    slug: "cloudflare",
    name: "Cloudflare",
    kind: "mcp",
    monogram: "CF",
    color: "#f38020",
    description: {
      de: "Zonen, DNS, Workers, R2 und mehr über den offiziellen Cloudflare-MCP-Server.",
      en: "Zones, DNS, Workers, R2 and more via the official Cloudflare MCP server.",
    },
  },
  {
    slug: "cloudflare-bindings",
    name: "Cloudflare Workers Bindings",
    kind: "mcp",
    monogram: "W",
    color: "#f6821f",
    description: {
      de: "Workers, KV, R2, D1 und Hyperdrive verwalten.",
      en: "Manage Workers, KV, R2, D1 and Hyperdrive.",
    },
  },
  {
    slug: "vercel",
    name: "Vercel",
    kind: "mcp",
    monogram: "▲",
    color: "#000000",
    description: {
      de: "Projekte, Deployments, Logs und Doku auf Vercel.",
      en: "Projects, deployments, logs and docs on Vercel.",
    },
  },
  {
    slug: "slack",
    name: "Slack",
    kind: "native",
    monogram: "S",
    color: "#4a154b",
    description: {
      de: "Kanäle auflisten, Verlauf lesen, suchen und Nachrichten senden.",
      en: "List channels, read history, search and send messages.",
    },
    tokenHint: {
      de: "Bot- oder User-Token (xoxb-/xoxp-) deiner Slack-App.",
      en: "Bot or user token (xoxb-/xoxp-) of your Slack app.",
    },
  },
  {
    slug: "gmail",
    name: "Gmail",
    kind: "native",
    monogram: "G",
    color: "#ea4335",
    description: {
      de: "E-Mails suchen und lesen, Entwürfe anlegen, senden (mit Freigabe), Labels.",
      en: "Search and read email, create drafts, send (with approval), labels.",
    },
    tokenHint: {
      de: "Google-OAuth-Client der Instanz nötig; zum Testen ein Access-Token.",
      en: "Needs the instance's Google OAuth client; for testing an access token.",
    },
  },
];

interface Connection {
  readonly server: string;
  readonly status: string;
  readonly tool_count?: number | null;
}
interface Account {
  readonly toolkit: string;
  readonly status: string;
  readonly id: string;
}
interface ToolEntry {
  readonly name: string;
  readonly title?: string | null;
  readonly mutating: boolean;
}

type Busy = { readonly slug: string; readonly label: string } | null;

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
  const { selectedId } = useCtoxMode();
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  const available = typeof bridge?.toolhubRequest === "function" && typeof selectedId === "string";
  const [connections, setConnections] = useState<ReadonlyArray<Connection>>([]);
  const [accounts, setAccounts] = useState<ReadonlyArray<Account>>([]);
  const [catalog, setCatalog] = useState<Record<string, ReadonlyArray<ToolEntry>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tokenOpen, setTokenOpen] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);

  const request = useCallback(
    async (route: string, body?: unknown) => {
      if (!bridge?.toolhubRequest || typeof selectedId !== "string") throw new Error("unavailable");
      const r = await bridge.toolhubRequest({
        instanceId: selectedId,
        route,
        ...(body === undefined ? {} : { body }),
      });
      const b = (r.body ?? {}) as { ok?: boolean; message?: string } & Record<string, unknown>;
      if (r.status !== 200) throw new Error(b.message ?? `HTTP ${r.status}`);
      return b;
    },
    [bridge, selectedId],
  );

  const refresh = useCallback(async () => {
    try {
      const c = await request("connections");
      setConnections((c.connections as Connection[] | undefined) ?? []);
      const k = await request("catalog");
      const toolkits =
        (k.toolkits as Array<{
          slug: string;
          tools: Array<{ slug: string; title: { de: string; en: string }; mutating: boolean }>;
        }>) ?? [];
      setCatalog((prev) => {
        const next = { ...prev };
        for (const tk of toolkits)
          next[tk.slug] = tk.tools.map((x) => ({
            name: x.slug,
            title: t(x.title.de, x.title.en),
            mutating: x.mutating,
          }));
        return next;
      });
      setAccounts(
        (k.accounts as Account[] | undefined) ?? (c.accounts as Account[] | undefined) ?? [],
      );
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [request, t]);

  useEffect(() => {
    if (available) void refresh();
  }, [available, refresh]);

  const isConnected = (c: ToolhubConnector) =>
    c.kind === "mcp"
      ? connections.some((x) => x.server === c.slug && x.status === "ACTIVE")
      : accounts.some((a) => a.toolkit === c.slug && a.status === "ACTIVE");

  const loadMcpTools = async (slug: string) => {
    try {
      const r = await request("mcp/tools", { server: slug });
      const tools = (
        (r.tools as Array<{
          name: string;
          title?: string;
          annotations?: { readOnlyHint?: boolean };
        }>) ?? []
      ).map((x) => ({
        name: x.name,
        title: x.title ?? null,
        mutating: x.annotations?.readOnlyHint !== true,
      }));
      setCatalog((prev) => ({ ...prev, [slug]: tools }));
    } catch {
      // Katalog bleibt leer, bis die Verbindung steht.
    }
  };

  const addMcp = async (c: ToolhubConnector) => {
    setErrors((e) => ({ ...e, [c.slug]: "" }));
    setBusy({ slug: c.slug, label: t("Anmeldung läuft …", "Signing in …") });
    try {
      const r = await request("connect", { server: c.slug });
      const url = String(r.authorize_url ?? "");
      if (!bridge?.toolhubAuthorize) throw new Error("unavailable");
      const result = await bridge.toolhubAuthorize({ authorizeUrl: url });
      if (result._tag === "failed")
        throw new Error(t("Anmeldung fehlgeschlagen.", "Sign-in failed."));
      await refresh();
      await loadMcpTools(c.slug);
    } catch (e) {
      setErrors((x) => ({ ...x, [c.slug]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const saveToken = async (c: ToolhubConnector) => {
    setBusy({ slug: c.slug, label: t("Wird gespeichert …", "Saving …") });
    try {
      await request("credential", { toolkit: c.slug, credential: token });
      setToken("");
      setTokenOpen(null);
      await refresh();
    } catch (e) {
      setErrors((x) => ({ ...x, [c.slug]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (c: ToolhubConnector) => {
    setConfirmRemove(null);
    try {
      if (c.kind === "mcp") await request("disconnect", { server: c.slug });
      else await request("disconnect", { server: c.slug, toolkit: c.slug });
      await refresh();
    } catch (e) {
      setErrors((x) => ({ ...x, [c.slug]: e instanceof Error ? e.message : String(e) }));
    }
  };

  const installed = TOOLHUB_CONNECTORS.filter(isConnected);

  return (
    <SettingsPageContainer
      title={t("Schnittstellen", "Integrations")}
      titleIcon={<PlugIcon className="size-4" />}
    >
      <p className="px-3 text-[13px] text-muted-foreground sm:px-4">
        {t(
          "Dienste, die Agenten dieser Instanz über „ctox toolhub“ und den Instanz-Proxy nutzen. Anmeldung und Zugangsdaten gehören der CTOX-Instanz, nicht diesem Gerät.",
          "Services that agents on this instance use via “ctox toolhub” and the instance proxy. Sign-in and credentials belong to the CTOX instance, not this device.",
        )}
      </p>
      {loadError !== null ? (
        <p
          role="alert"
          className="mx-3 flex items-start gap-1.5 text-[12.5px] text-destructive sm:mx-4"
        >
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {t(
            "Instanz antwortet nicht auf Toolhub-Anfragen:",
            "Instance does not answer toolhub requests:",
          )}{" "}
          {loadError}
        </p>
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
          installed.map((c) => (
            <SettingsRow
              key={c.slug}
              title={
                <span className="flex items-center gap-3">
                  <ConnectorLogo connector={c} />
                  <span className="flex flex-col">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-[12px] text-muted-foreground">
                      <code>ctox toolhub exec {c.slug}.&lt;tool&gt;</code>
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
                confirmRemove === c.slug ? (
                  <span className="flex gap-1.5">
                    <Button size="xs" variant="destructive" onClick={() => void remove(c)}>
                      {t("Trennen", "Disconnect")}
                    </Button>
                    <Button size="xs" variant="outline" onClick={() => setConfirmRemove(null)}>
                      {t("Abbrechen", "Cancel")}
                    </Button>
                  </span>
                ) : (
                  <Button size="xs" variant="outline" onClick={() => setConfirmRemove(c.slug)}>
                    {t("Entfernen", "Remove")}
                  </Button>
                )
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection id="integrations-store" title={t("Verfügbar", "Available")}>
        <div className="grid grid-cols-1 gap-3 px-3 pb-2 sm:grid-cols-2 sm:px-4 xl:grid-cols-3">
          {TOOLHUB_CONNECTORS.map((c) => {
            const connected = isConnected(c);
            const tools = catalog[c.slug] ?? [];
            const isBusy = busy?.slug === c.slug;
            return (
              <div
                key={c.slug}
                data-toolhub-connector={c.slug}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3"
              >
                <div className="flex items-start gap-3">
                  <ConnectorLogo connector={c} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      <Badge variant="outline">{c.kind === "mcp" ? "MCP" : "CTOX"}</Badge>
                    </div>
                    <p className="mt-1 text-[12.5px] text-muted-foreground">
                      {t(c.description.de, c.description.en)}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="flex items-center gap-1 self-start text-[12px] text-muted-foreground"
                  aria-expanded={details === c.slug}
                  onClick={() => {
                    const open = details === c.slug ? null : c.slug;
                    setDetails(open);
                    if (open && c.kind === "mcp" && connected) void loadMcpTools(c.slug);
                  }}
                >
                  <ChevronDownIcon
                    className={`size-3.5 transition-transform ${details === c.slug ? "rotate-180" : ""}`}
                  />
                  {t("Werkzeuge", "Tools")}
                  {tools.length > 0 ? ` (${tools.length})` : ""}
                </button>
                {details === c.slug ? (
                  tools.length === 0 ? (
                    <p className="text-[12px] text-muted-foreground">
                      {c.kind === "mcp"
                        ? t(
                            "Der Werkzeugkatalog kommt vom Anbieter und erscheint nach dem Verbinden.",
                            "The tool catalog comes from the provider and appears after connecting.",
                          )
                        : t(
                            "Katalog wird von der Instanz geladen …",
                            "Loading catalog from the instance …",
                          )}
                    </p>
                  ) : (
                    <ul className="max-h-48 space-y-1 overflow-auto text-[12px]">
                      {tools.map((x) => (
                        <li key={x.name} className="flex items-center justify-between gap-2">
                          <span className="truncate">
                            <code>{x.name}</code>
                            {x.title ? (
                              <span className="text-muted-foreground"> · {x.title}</span>
                            ) : null}
                          </span>
                          {x.mutating ? (
                            <Badge variant="warning">{t("Freigabe", "Approval")}</Badge>
                          ) : (
                            <Badge variant="outline">{t("Lesen", "Read")}</Badge>
                          )}
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
                {c.kind === "native" && tokenOpen === c.slug ? (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveToken(c);
                    }}
                  >
                    <label
                      className="text-[12px] text-muted-foreground"
                      htmlFor={`token-${c.slug}`}
                    >
                      {t(c.tokenHint!.de, c.tokenHint!.en)}
                    </label>
                    <Input
                      id={`token-${c.slug}`}
                      type="password"
                      autoComplete="off"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        type="button"
                        onClick={() => {
                          setTokenOpen(null);
                          setToken("");
                        }}
                      >
                        {t("Abbrechen", "Cancel")}
                      </Button>
                      <Button size="xs" type="submit" disabled={token.trim().length < 8 || isBusy}>
                        {t("An Instanz übergeben", "Save to instance")}
                      </Button>
                    </div>
                  </form>
                ) : null}
                {errors[c.slug] ? (
                  <p role="alert" className="flex items-start gap-1.5 text-[12px] text-destructive">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                    {errors[c.slug]}
                  </p>
                ) : null}
                <div className="mt-auto flex items-center justify-end gap-2">
                  {connected ? (
                    <Badge variant="success">
                      <CheckCircle2Icon className="me-1 size-3" />
                      {t("Verbunden", "Connected")}
                    </Badge>
                  ) : tokenOpen === c.slug ? null : (
                    <Button
                      size="sm"
                      data-workjet-action={`integrations.add.${c.slug}`}
                      disabled={!available || isBusy}
                      onClick={() => (c.kind === "mcp" ? void addMcp(c) : setTokenOpen(c.slug))}
                    >
                      {isBusy ? <Loader2Icon className="me-1 size-3.5 animate-spin" /> : null}
                      {isBusy ? busy?.label : t("Hinzufügen", "Add")}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {!available ? (
          <p className="px-3 text-[12px] text-muted-foreground sm:px-4">
            {t(
              "Verbinden ist in der Workjet-Desktop-App mit gewählter Instanz möglich.",
              "Connecting needs the Workjet desktop app with a selected instance.",
            )}
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
