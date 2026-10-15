// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Pending toolhub requests of the CTOX instance (`ui/requests`), pinned above
 * the composer until they are resolved or declined.
 *
 * Every harness raises the same request on the instance (`ctox ui request …`,
 * or the supervisor on behalf of a worker); Workjet renders it with the shared
 * cards from `../toolhub/ToolhubCards`, so the UI is identical everywhere.
 * The list is pulled from the instance, so cards survive new messages, view
 * switches and app restarts. Several open requests stack.
 *
 * Developer mode only until ctox #708 lands: without it nothing mounts, so
 * there is no polling and no desktop IPC call.
 */
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useUiText } from "../../hooks/useUiText";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import { INTEGRATIONS } from "../settings/integrationsCatalog";
import {
  ConfirmCard,
  ConnectCard,
  CredentialCard,
  type Localized,
  type T,
  type ToolhubParam,
  type ToolhubSecretField,
} from "../toolhub/ToolhubCards";

export type UiRequestStatus = "open" | "done" | "declined" | "expired";
export interface SessionUiRequest {
  readonly id: string;
  readonly kind: "credential" | "connect" | "confirm";
  readonly status: UiRequestStatus;
  readonly toolkit: string;
  readonly title?: string | Localized;
  readonly fields?: ReadonlyArray<ToolhubSecretField>;
  readonly params?: ReadonlyArray<ToolhubParam>;
  readonly message?: string;
  readonly session?: string;
  readonly created_at: number;
  readonly resolved_at?: number;
}

const POLL_MS = 3000;
const CACHE_KEY = "workjet.toolhub.pendingRequests.v1";

function entryOf(slug: string) {
  return INTEGRATIONS.find((e) => e.slug === slug) ?? null;
}
export function appName(slug: string): string {
  return entryOf(slug)?.name ?? slug.charAt(0).toUpperCase() + slug.slice(1).replace(/[-_]/g, " ");
}

/**
 * Pure: which requests to pin right now. Open ones stay until resolved and
 * then disappear (no status pill). Oldest first, so the stack order is stable
 * while new requests arrive.
 */
export function visibleRequests(
  all: ReadonlyArray<SessionUiRequest>,
  sessionId: string | null,
): SessionUiRequest[] {
  return all
    .filter((r) => !r.session || r.session === sessionId)
    .filter((r) => r.status === "open")
    .toSorted((a, b) => a.created_at - b.created_at);
}

/** Strip anything that is not plain request metadata before caching it locally. */
export function cacheable(list: ReadonlyArray<SessionUiRequest>): SessionUiRequest[] {
  return list
    .filter((r) => r.status === "open")
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      toolkit: r.toolkit,
      created_at: r.created_at,
      ...(r.title ? { title: r.title } : {}),
      ...(r.fields ? { fields: r.fields } : {}),
      ...(r.params ? { params: r.params } : {}),
      ...(r.message ? { message: r.message } : {}),
      ...(r.session ? { session: r.session } : {}),
    }));
}

function readCache(instance: string | null): SessionUiRequest[] {
  if (!instance || typeof localStorage === "undefined") return [];
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as Record<
      string,
      SessionUiRequest[]
    >;
    return all[instance] ?? [];
  } catch {
    return [];
  }
}
function writeCache(instance: string | null, list: ReadonlyArray<SessionUiRequest>) {
  if (!instance || typeof localStorage === "undefined") return;
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as Record<
      string,
      SessionUiRequest[]
    >;
    all[instance] = cacheable(list);
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {
    // Cache is only a head start after restart; the instance stays the source of truth.
  }
}

/** Pinned toolhub requests; renders (and polls) only in developer mode. */
export function SessionRequestCards({ sessionId }: { readonly sessionId: string | null }) {
  const developerMode = useClientSettings((settings) => settings.developerMode);
  return developerMode ? <SessionRequestCardsLive sessionId={sessionId} /> : null;
}

function SessionRequestCardsLive({ sessionId }: { readonly sessionId: string | null }) {
  const t = useUiText();
  const { selectedId } = useCtoxMode();
  const instance = typeof selectedId === "string" ? selectedId : null;
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  const [requests, setRequests] = useState<ReadonlyArray<SessionUiRequest>>(() =>
    readCache(instance),
  );
  const [expanded, setExpanded] = useState(false);
  const alive = useRef(true);

  const call = useCallback(
    async (route: string, body: unknown) => {
      if (!bridge?.toolhubRequest || !instance)
        throw Object.assign(new Error("unavailable"), { status: 0 });
      const r = await bridge.toolhubRequest({ instanceId: instance, route, body });
      const b = (r.body ?? {}) as Record<string, unknown>;
      if (r.status !== 200)
        throw Object.assign(new Error(String(b.code ?? b.message ?? r.status)), {
          status: r.status,
        });
      return b;
    },
    [bridge, instance],
  );

  const load = useCallback(async () => {
    try {
      const b = await call("ui/requests", sessionId ? { session: sessionId } : {});
      const list = (b.requests as SessionUiRequest[] | undefined) ?? [];
      if (!alive.current) return;
      setRequests(list);
      writeCache(instance, list);
    } catch {
      // Instance unreachable: keep the last known cards pinned.
    }
  }, [call, sessionId, instance]);

  useEffect(() => {
    alive.current = true;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  return (
    <PinnedRequestStack
      requests={visibleRequests(requests, sessionId)}
      expanded={expanded}
      setExpanded={setExpanded}
      t={t}
      instance={instance}
      call={call}
      onChanged={load}
    />
  );
}

/** Presentational stack; exported for screenshots and tests. */
export function PinnedRequestStack(props: {
  requests: ReadonlyArray<SessionUiRequest>;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  t: T;
  instance: string | null;
  call: (route: string, body: unknown) => Promise<Record<string, unknown>>;
  onChanged: () => Promise<void>;
}) {
  const { requests, t } = props;
  if (requests.length === 0) return null;
  const head = requests[0]!;
  const rest = requests.slice(1);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-1 pb-2" data-pinned-requests>
      {rest.length > 0 ? (
        <button
          type="button"
          aria-expanded={props.expanded}
          aria-label={props.expanded ? t("Einklappen", "Collapse") : t("Alle anzeigen", "Show all")}
          onClick={() => props.setExpanded(!props.expanded)}
          className="flex items-center self-start px-1 text-muted-foreground hover:text-foreground"
        >
          {props.expanded ? (
            <ChevronUpIcon className="size-3.5" />
          ) : (
            <ChevronDownIcon className="size-3.5" />
          )}
        </button>
      ) : null}
      <div className="relative">
        <RequestCard
          request={head}
          t={t}
          instance={props.instance}
          call={props.call}
          onChanged={props.onChanged}
        />
        {!props.expanded && rest.length > 0 ? (
          <>
            <div
              aria-hidden
              className="mx-3 h-1.5 rounded-b-2xl border-x border-b border-border/50 bg-card/80"
            />
            {rest.length > 1 ? (
              <div
                aria-hidden
                className="mx-6 h-1.5 rounded-b-2xl border-x border-b border-border/40 bg-card/60"
              />
            ) : null}
          </>
        ) : null}
      </div>
      {props.expanded
        ? rest.map((r) => (
            <RequestCard
              key={r.id}
              request={r}
              t={t}
              instance={props.instance}
              call={props.call}
              onChanged={props.onChanged}
            />
          ))
        : null}
    </div>
  );
}

function titleOf(r: SessionUiRequest, t: T, name: string): string {
  if (typeof r.title === "string" && r.title) return r.title;
  if (r.title && typeof r.title === "object") return t(r.title.de, r.title.en);
  return r.kind === "credential"
    ? t(`${name} API-Schlüssel`, `${name} API key`)
    : r.kind === "confirm"
      ? (r.message ?? t(`${name}: Aktion bestätigen`, `${name}: confirm action`))
      : name;
}

export function RequestCard({
  request: r,
  t,
  instance,
  call,
  onChanged,
}: {
  request: SessionUiRequest;
  t: T;
  instance: string | null;
  call: (route: string, body: unknown) => Promise<Record<string, unknown>>;
  onChanged: () => Promise<void>;
}) {
  const entry = entryOf(r.toolkit);
  const name = appName(r.toolkit);
  const [busy, setBusy] = useState(false);
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;

  // No error line on the card: a failed step leaves the card open, so the
  // user simply tries again; the next poll reflects the instance's state.
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } catch {
      // Card stays open.
    } finally {
      setBusy(false);
    }
  };
  const decide = (action: "approve" | "decline") =>
    run(async () => void (await call("ui/resolve", { id: r.id, action })));

  if (r.kind === "credential") {
    const secrets = r.fields && r.fields.length > 0 ? r.fields : [{ name: "token", secret: true }];
    return (
      <CredentialCard
        id={r.id}
        t={t}
        appName={name}
        title={titleOf(r, t, name)}
        help={
          r.message ??
          t(
            `Dein Agent braucht Zugriff auf ${name}, um weiterzumachen.`,
            `Your agent needs access to ${name} to continue.`,
          )
        }
        secrets={secrets}
        params={r.params ?? []}
        busy={busy}
        status={r.status}
        onSubmit={(values) =>
          void run(
            async () => void (await call("ui/resolve", { id: r.id, action: "submit", values })),
          )
        }
        onDecline={() => void decide("decline")}
      />
    );
  }
  if (r.kind === "connect") {
    return (
      <ConnectCard
        id={r.id}
        t={t}
        name={titleOf(r, t, name)}
        description={
          r.message ??
          (entry
            ? t(entry.description.de, entry.description.en)
            : t(`Zugriff auf ${name} freigeben`, `Give access to ${name}`))
        }
        logo={entry?.logo ?? null}
        busy={busy}
        status={r.status}
        onDecline={() => void decide("decline")}
        onAuthorize={() =>
          void run(async () => {
            const c = await call("connect", { server: r.toolkit });
            if (!bridge?.toolhubAuthorize || !instance)
              throw Object.assign(new Error("unavailable"), { status: 0 });
            const result = await bridge.toolhubAuthorize({
              instanceId: instance,
              toolkit: r.toolkit,
              authorizeUrl: String(c.authorize_url ?? ""),
            });
            if (result._tag === "cancelled") return;
            if (result._tag === "failed" || !result.callbackUrl)
              throw Object.assign(new Error("authorize_failed"), { status: 500 });
            await call("oauth/complete", { callback_url: result.callbackUrl });
            await call("ui/resolve", { id: r.id, action: "connected" });
          })
        }
      />
    );
  }
  return (
    <ConfirmCard
      id={r.id}
      t={t}
      title={titleOf(r, t, name)}
      help={t("Dein Agent wartet auf deine Freigabe.", "Your agent is waiting for your approval.")}
      busy={busy}
      status={r.status}
      onDecide={(a) => void decide(a)}
    />
  );
}
