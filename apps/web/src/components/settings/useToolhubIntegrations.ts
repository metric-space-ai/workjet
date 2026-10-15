// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Toolhub-Zustand einer CTOX-Instanz (über den angemeldeten Guest): Verbindungen,
 * Konten, Werkzeuge und die Verbinden-/Trennen-Schritte. Die Instanz besitzt
 * Registrierung, Rückleitung und Tokens; die App öffnet nur die Anmelde-URL,
 * die die Instanz ausgibt, oder übergibt ein Token an die Instanz.
 *
 * Ein fehlgeschlagener Schritt lässt den Zustand unverändert; eine nicht
 * erreichbare Instanz wird still erneut abgefragt.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useUiText } from "../../hooks/useUiText";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import type { ToolhubParam } from "../toolhub/ToolhubCards";
import type { IntegrationEntry } from "./integrationsCatalog";

interface Connection {
  readonly server: string;
  readonly status: string;
}
interface Account {
  readonly toolkit: string;
  readonly status: string;
}
export interface ToolEntry {
  readonly name: string;
  readonly title?: string | null;
  readonly mutating: boolean;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const RETRY_MS = 15_000;

export function useToolhubIntegrations() {
  const t = useUiText();
  const { selectedId, discovery } = useCtoxMode();
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  const available = typeof bridge?.toolhubRequest === "function" && typeof selectedId === "string";
  const instanceName = useMemo(() => {
    if (discovery !== "loading" && discovery._tag === "ready") {
      const hit = discovery.instances.find((i) => i.id === selectedId);
      if (hit?.displayName) return String(hit.displayName);
    }
    return "Instanz";
  }, [discovery, selectedId]);

  const [connections, setConnections] = useState<ReadonlyArray<Connection>>([]);
  const [accounts, setAccounts] = useState<ReadonlyArray<Account>>([]);
  const [catalog, setCatalog] = useState<Record<string, ReadonlyArray<ToolEntry>>>({});
  const [connectionFields, setConnectionFields] = useState<
    Record<string, ReadonlyArray<ToolhubParam>>
  >({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const retryTimer = useRef<number | null>(null);

  const request = useCallback(
    async (route: string, body?: unknown) => {
      if (!bridge?.toolhubRequest || typeof selectedId !== "string")
        throw new RequestError(0, "unavailable");
      const r = await bridge.toolhubRequest({
        instanceId: selectedId,
        route,
        ...(body === undefined ? {} : { body }),
      });
      const b = (r.body ?? {}) as { ok?: boolean; message?: string; code?: string } & Record<
        string,
        unknown
      >;
      if (r.status !== 200)
        throw new RequestError(r.status, String(b.code ?? b.message ?? "error"));
      return b;
    },
    [bridge, selectedId],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
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
      setAccounts((k.accounts as Account[] | undefined) ?? []);
      setConnectionFields(
        (k.connection_fields as Record<string, ReadonlyArray<ToolhubParam>> | undefined) ?? {},
      );
      setLoaded(true);
    } catch (e) {
      if (!(e instanceof RequestError) || e.status === 0)
        retryTimer.current = window.setTimeout(() => void refresh(), RETRY_MS);
    }
  }, [request, t]);

  useEffect(() => {
    if (available) void refresh();
    return () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    };
  }, [available, refresh]);

  const isConnected = useCallback(
    (e: IntegrationEntry) =>
      e.connect === "mcp"
        ? connections.some((x) => x.server === e.slug && x.status === "ACTIVE")
        : accounts.some((a) => a.toolkit === e.slug && a.status === "ACTIVE"),
    [accounts, connections],
  );
  const isExpired = useCallback(
    (e: IntegrationEntry) =>
      e.connect === "mcp"
        ? connections.some((x) => x.server === e.slug && /EXPIRED|INVALID/.test(x.status))
        : accounts.some((a) => a.toolkit === e.slug && /EXPIRED|INVALID/.test(a.status)),
    [accounts, connections],
  );

  const loadMcpTools = useCallback(
    async (slug: string) => {
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
        // Werkzeugliste erscheint, sobald die Verbindung steht.
      }
    },
    [request],
  );

  /** Liefert `true`, wenn die Verbindung steht; ein Abbruch ist kein Fehler. */
  const connectMcp = async (entry: IntegrationEntry): Promise<boolean | "cancelled"> => {
    if (typeof selectedId !== "string") return false;
    setBusy(entry.slug);
    try {
      const r = await request("connect", { server: entry.slug });
      if (!bridge?.toolhubAuthorize) throw new RequestError(0, "unavailable");
      const result = await bridge.toolhubAuthorize({
        instanceId: selectedId,
        toolkit: entry.slug,
        authorizeUrl: String(r.authorize_url ?? ""),
      });
      if (result._tag === "cancelled") return "cancelled";
      if (result._tag === "failed" || !result.callbackUrl) throw new Error("authorize_failed");
      await request("oauth/complete", { callback_url: result.callbackUrl });
      await refresh();
      await loadMcpTools(entry.slug);
      return true;
    } catch {
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveToken = async (
    entry: IntegrationEntry,
    values: Record<string, string>,
  ): Promise<boolean> => {
    setBusy(entry.slug);
    try {
      const params: Record<string, string> = {};
      for (const f of connectionFields[entry.slug] ?? []) {
        const v = (values[f.key] ?? "").trim();
        if (v) params[f.key] = v;
      }
      await request("credential", {
        toolkit: entry.slug,
        credential: (values.token ?? "").trim(),
        ...(Object.keys(params).length > 0 ? { params } : {}),
      });
      await refresh();
      return true;
    } catch {
      return false;
    } finally {
      setBusy(null);
    }
  };

  const remove = async (entry: IntegrationEntry): Promise<boolean> => {
    try {
      await request(
        "disconnect",
        entry.connect === "mcp"
          ? { server: entry.slug }
          : { server: entry.slug, toolkit: entry.slug },
      );
      await refresh();
      return true;
    } catch {
      return false;
    }
  };

  return {
    available,
    instanceName,
    loaded,
    busy,
    catalog,
    connectionFields,
    refresh,
    isConnected,
    isExpired,
    loadMcpTools,
    connectMcp,
    saveToken,
    remove,
  };
}

export type ToolhubIntegrations = ReturnType<typeof useToolhubIntegrations>;
