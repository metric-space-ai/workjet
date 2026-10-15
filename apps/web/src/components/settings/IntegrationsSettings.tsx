// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Einstellungen → Schnittstellen: App-Store im Stil von „Apps und Skills“.
 *
 * Zustand kommt immer von der CTOX-Instanz (über den angemeldeten Guest). Die
 * Instanz besitzt Registrierung, Rückleitung und Tokens; die App öffnet nur die
 * Anmelde-URL, die die Instanz ausgibt, oder übergibt ein Token an die Instanz.
 * Keine Zustandstexte: ein fehlgeschlagener Schritt lässt die Zeile unverändert,
 * eine nicht erreichbare Instanz wird still erneut abgefragt.
 *
 * Nur im Entwicklermodus, bis ctox #708 und die Übergabe Main-Prozess →
 * Instanz stehen: ohne Entwicklermodus wird nichts gemountet, es gibt also
 * weder Abfragen noch Desktop-IPC.
 */
import { ArrowLeftIcon, CheckIcon, Loader2Icon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useUiText } from "../../hooks/useUiText";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import { Input } from "../ui/input";
import { CredentialCard, type ToolhubParam } from "../toolhub/ToolhubCards";
import {
  INTEGRATIONS,
  INTEGRATION_CATEGORIES,
  type IntegrationCategory,
  type IntegrationEntry,
} from "./integrationsCatalog";

type T = (de: string, en: string) => string;

interface Connection {
  readonly server: string;
  readonly status: string;
}
interface Account {
  readonly toolkit: string;
  readonly status: string;
}
interface ToolEntry {
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

function Logo({ entry, size = "md" }: { entry: IntegrationEntry; size?: "md" | "lg" }) {
  const box = size === "lg" ? "size-14 rounded-2xl" : "size-11 rounded-xl";
  return (
    <span
      aria-hidden
      className={`${box} flex shrink-0 items-center justify-center overflow-hidden border border-border/60 bg-white`}
    >
      {entry.logo ? (
        <img src={entry.logo} alt="" className="size-[70%] object-contain" draggable={false} />
      ) : (
        <span className="text-[15px] font-semibold text-neutral-700">{entry.name.slice(0, 1)}</span>
      )}
    </span>
  );
}

/** Dezenter Pillen-Knopf wie im Referenz-Store. */
function Pill({
  children,
  onClick,
  disabled,
  action,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  action?: string;
}) {
  return (
    <button
      type="button"
      data-workjet-action={action}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-muted px-3.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/70 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Added({ t }: { t: T }) {
  return (
    <span className="inline-flex h-8 shrink-0 items-center gap-1 px-2 text-[13px] text-muted-foreground">
      <CheckIcon className="size-3.5 text-emerald-500" />
      {t("Hinzugefügt", "Added")}
    </span>
  );
}

const PREVIEW = 6;

/** Nur Einträge mit Anschluss erscheinen; „Bald verfügbar“-Kacheln gibt es nicht. */
export const CONNECTABLE_INTEGRATIONS: ReadonlyArray<IntegrationEntry> = INTEGRATIONS.filter(
  (e) => e.connect !== null,
);

export function IntegrationsSettingsPanel() {
  const developerMode = useClientSettings((settings) => settings.developerMode);
  return developerMode ? <IntegrationsStore /> : null;
}

function IntegrationsStore() {
  const t = useUiText();
  const { selectedId, discovery } = useCtoxMode();
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  const available = typeof bridge?.toolhubRequest === "function" && typeof selectedId === "string";
  const instanceName = useMemo(() => {
    if (discovery !== "loading" && discovery._tag === "ready") {
      const hit = discovery.instances.find((i) => i.id === selectedId);
      if (hit?.displayName) return String(hit.displayName);
    }
    return t("Deine Instanz", "Your instance");
  }, [discovery, selectedId, t]);

  const [connections, setConnections] = useState<ReadonlyArray<Connection>>([]);
  const [accounts, setAccounts] = useState<ReadonlyArray<Account>>([]);
  const [catalog, setCatalog] = useState<Record<string, ReadonlyArray<ToolEntry>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<IntegrationCategory | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [connectionFields, setConnectionFields] = useState<
    Record<string, ReadonlyArray<ToolhubParam>>
  >({});
  const [confirmRemove, setConfirmRemove] = useState(false);
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
    } catch (e) {
      // Nicht erreichbar: still erneut versuchen, ohne Hinweistext.
      if (!(e instanceof RequestError) || e.status === 0)
        retryTimer.current = window.setTimeout(() => void refresh(), 15_000);
    }
  }, [request, t]);

  useEffect(() => {
    if (available) void refresh();
    return () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    };
  }, [available, refresh]);

  const isConnected = (e: IntegrationEntry) =>
    e.connect === "mcp"
      ? connections.some((x) => x.server === e.slug && x.status === "ACTIVE")
      : accounts.some((a) => a.toolkit === e.slug && a.status === "ACTIVE");
  const isExpired = (e: IntegrationEntry) =>
    e.connect === "mcp"
      ? connections.some((x) => x.server === e.slug && /EXPIRED|INVALID/.test(x.status))
      : accounts.some((a) => a.toolkit === e.slug && /EXPIRED|INVALID/.test(a.status));

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

  // Ein fehlgeschlagener Schritt lässt die Zeile unverändert; der Knopf bleibt
  // da, ein erneuter Klick versucht es noch einmal.
  const connectMcp = async (entry: IntegrationEntry) => {
    if (typeof selectedId !== "string") return;
    setBusy(entry.slug);
    try {
      const r = await request("connect", { server: entry.slug });
      if (!bridge?.toolhubAuthorize) throw new RequestError(0, "unavailable");
      const result = await bridge.toolhubAuthorize({
        instanceId: selectedId,
        toolkit: entry.slug,
        authorizeUrl: String(r.authorize_url ?? ""),
      });
      if (result._tag === "cancelled") return;
      if (result._tag === "failed" || !result.callbackUrl) throw new Error("authorize_failed");
      await request("oauth/complete", { callback_url: result.callbackUrl });
      await refresh();
      await loadMcpTools(entry.slug);
    } catch {
      // Zeile bleibt unverändert.
    } finally {
      setBusy(null);
    }
  };

  const saveToken = async (entry: IntegrationEntry, values: Record<string, string>) => {
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
    } catch {
      // Formular bleibt offen.
    } finally {
      setBusy(null);
    }
  };

  const remove = async (entry: IntegrationEntry) => {
    setConfirmRemove(false);
    try {
      await request(
        "disconnect",
        entry.connect === "mcp"
          ? { server: entry.slug }
          : { server: entry.slug, toolkit: entry.slug },
      );
      await refresh();
    } catch {
      // Verbindung bleibt bestehen; erneut „Trennen“ versucht es noch einmal.
    }
  };

  const open = (entry: IntegrationEntry) => {
    setSelected(entry.slug);
    setConfirmRemove(false);
    if (entry.connect === "mcp" && isConnected(entry)) void loadMcpTools(entry.slug);
  };

  const q = query.trim().toLowerCase();
  const matches = (e: IntegrationEntry) =>
    q === "" ||
    e.name.toLowerCase().includes(q) ||
    t(e.description.de, e.description.en).toLowerCase().includes(q);

  const entry = selected ? CONNECTABLE_INTEGRATIONS.find((e) => e.slug === selected) : undefined;

  const rowAction = (e: IntegrationEntry) => {
    if (isConnected(e)) return <Added t={t} />;
    if (busy === e.slug)
      return (
        <Pill onClick={() => undefined} disabled>
          <Loader2Icon className="size-3.5 animate-spin" />
          {t("Verbinde …", "Connecting …")}
        </Pill>
      );
    if (isExpired(e))
      return (
        <Pill
          action={`integrations.add.${e.slug}`}
          onClick={() => (e.connect === "mcp" ? void connectMcp(e) : open(e))}
        >
          {t("Neu verbinden", "Reconnect")}
        </Pill>
      );
    return (
      <Pill
        action={`integrations.add.${e.slug}`}
        disabled={e.connect === "mcp" && !available}
        onClick={() => (e.connect === "mcp" ? void connectMcp(e) : open(e))}
      >
        {e.connect === "token" ? t("Verbinden", "Connect") : t("Hinzufügen", "Add")}
      </Pill>
    );
  };

  const searchBar = (
    <div className="flex items-center gap-2 pb-1 pt-1">
      <div className="relative flex-1">
        <SearchIcon className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(ev) => {
            setQuery(ev.target.value);
            setSelected(null);
          }}
          placeholder={t("Apps durchsuchen", "Search apps")}
          aria-label={t("Apps durchsuchen", "Search apps")}
          className="h-10 rounded-full ps-10"
        />
      </div>
    </div>
  );

  return (
    <div
      className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-4 sm:px-6"
      data-integrations-store
    >
      {searchBar}
      {entry ? (
        <Detail
          entry={entry}
          t={t}
          connected={isConnected(entry)}
          expired={isExpired(entry)}
          busy={busy === entry.slug}
          available={available}
          tools={catalog[entry.slug] ?? []}
          instanceName={instanceName}
          connectionFields={connectionFields[entry.slug] ?? []}
          confirmRemove={confirmRemove}
          setConfirmRemove={setConfirmRemove}
          onBack={() => setSelected(null)}
          onConnect={() => void connectMcp(entry)}
          onSaveToken={(values) => void saveToken(entry, values)}
          onRemove={() => void remove(entry)}
        />
      ) : (
        <>
          <p className="text-[14px] text-muted-foreground">
            {t(
              "Verbinde Apps, damit deine Agenten sie nutzen können.",
              "Connect apps so your agents can use them.",
            )}
          </p>
          {INTEGRATION_CATEGORIES.filter((c) => expanded === null || expanded === c.id).map(
            (cat) => {
              const items = CONNECTABLE_INTEGRATIONS.filter(
                (e) => e.category === cat.id && matches(e),
              );
              if (items.length === 0) return null;
              const shown = expanded === cat.id || q !== "" ? items : items.slice(0, PREVIEW);
              return (
                <section
                  key={cat.id}
                  className="flex flex-col gap-1"
                  aria-label={t(cat.de, cat.en)}
                >
                  <div className="flex items-center justify-between py-2">
                    <h2 className="text-[16px] font-medium">{t(cat.de, cat.en)}</h2>
                    {q === "" && items.length > PREVIEW ? (
                      <button
                        type="button"
                        className="text-[13px] text-muted-foreground hover:text-foreground"
                        onClick={() => setExpanded(expanded === cat.id ? null : cat.id)}
                      >
                        {expanded === cat.id
                          ? t("Weniger anzeigen", "Show less")
                          : t("Alle anzeigen", "Show all")}
                      </button>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
                    {shown.map((e) => (
                      <div
                        key={e.slug}
                        role="button"
                        tabIndex={0}
                        data-toolhub-connector={e.slug}
                        onClick={() => open(e)}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter" || ev.key === " ") {
                            ev.preventDefault();
                            open(e);
                          }
                        }}
                        className="flex cursor-pointer items-center gap-3.5 rounded-xl px-2.5 py-2.5 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                      >
                        <Logo entry={e} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14.5px] font-medium">{e.name}</span>
                          <span className="block truncate text-[13.5px] text-muted-foreground">
                            {t(e.description.de, e.description.en)}
                          </span>
                        </span>
                        {rowAction(e)}
                      </div>
                    ))}
                  </div>
                </section>
              );
            },
          )}
          {CONNECTABLE_INTEGRATIONS.every((e) => !matches(e)) ? (
            <p className="py-8 text-center text-[13px] text-muted-foreground">
              {t(`Keine App für „${query}“ gefunden.`, `No app found for “${query}”.`)}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function Detail(props: {
  entry: IntegrationEntry;
  t: T;
  connected: boolean;
  expired: boolean;
  busy: boolean;
  available: boolean;
  tools: ReadonlyArray<ToolEntry>;
  instanceName: string;
  connectionFields: ReadonlyArray<ToolhubParam>;
  confirmRemove: boolean;
  setConfirmRemove: (v: boolean) => void;
  onBack: () => void;
  onConnect: () => void;
  onSaveToken: (values: Record<string, string>) => void;
  onRemove: () => void;
}) {
  const { entry, t } = props;
  // Nur Bedienhilfe vor dem Verbinden, kein Zustandstext danach.
  const hint =
    props.connected || props.expired
      ? null
      : entry.connect === "mcp"
        ? t(
            `Beim Verbinden öffnet sich die Anmeldeseite von ${entry.name}. Du wählst dort, worauf deine Agenten zugreifen dürfen.`,
            `Connecting opens the ${entry.name} sign-in page, where you choose what your agents may access.`,
          )
        : entry.connect === "token"
          ? t(
              `Füge einen Zugangsschlüssel von ${entry.name} ein. Er wird nur auf ${props.instanceName} gespeichert.`,
              `Paste an access key from ${entry.name}. It is stored only on ${props.instanceName}.`,
            )
          : null;

  return (
    <div className="flex flex-col gap-5" data-integration-detail={entry.slug}>
      <button
        type="button"
        onClick={props.onBack}
        className="inline-flex items-center gap-1.5 self-start text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {t("Alle Apps", "All apps")}
      </button>
      <div className="flex items-center gap-4">
        <Logo entry={entry} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] font-medium">{entry.name}</h2>
          <p className="text-[13.5px] text-muted-foreground">
            {t(entry.description.de, entry.description.en)}
          </p>
        </div>
        {props.connected ? (
          props.confirmRemove ? (
            <span className="flex gap-1.5">
              <Pill onClick={props.onRemove}>{t("Ja, trennen", "Yes, disconnect")}</Pill>
              <Pill onClick={() => props.setConfirmRemove(false)}>{t("Abbrechen", "Cancel")}</Pill>
            </span>
          ) : (
            <Pill onClick={() => props.setConfirmRemove(true)}>{t("Trennen", "Disconnect")}</Pill>
          )
        ) : entry.connect === "mcp" ? (
          <Pill
            action={`integrations.add.${entry.slug}`}
            disabled={props.busy || !props.available}
            onClick={props.onConnect}
          >
            {props.busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            {props.busy
              ? t("Verbinde …", "Connecting …")
              : props.expired
                ? t("Neu verbinden", "Reconnect")
                : t("Hinzufügen", "Add")}
          </Pill>
        ) : null}
      </div>
      {hint ? <p className="text-[13.5px]">{hint}</p> : null}
      {entry.connect === "token" && !props.connected ? (
        <CredentialCard
          t={t}
          appName={entry.name}
          title={t(`${entry.name} API-Schlüssel`, `${entry.name} API key`)}
          help={t(
            `Wird nur auf ${props.instanceName} gespeichert und von allen Agenten der Instanz genutzt.`,
            `Stored only on ${props.instanceName} and used by all agents on the instance.`,
          )}
          secrets={[{ name: "token", secret: true }]}
          params={props.connectionFields}
          busy={props.busy}
          disabled={!props.available}
          onSubmit={props.onSaveToken}
        />
      ) : null}
      {props.tools.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-[14px] font-medium">
            {t("Was deine Agenten damit tun können", "What your agents can do")}
          </h3>
          <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
            {props.tools.map((x) => (
              <li
                key={x.name}
                className="flex items-center justify-between gap-3 px-3.5 py-2 text-[13px]"
              >
                <span className="min-w-0 truncate">{x.title || x.name}</span>
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {x.mutating ? t("fragt vorher nach", "asks first") : t("nur lesen", "read only")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
