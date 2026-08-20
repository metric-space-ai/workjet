/**
 * The global multi-computer activity overview (docs/workjet-plan.md → "the
 * desktop shows a global multi-computer activity overview built on that
 * replicated redacted projection, including the last known state of currently
 * offline machines").
 *
 * READ THIS BEFORE ADDING A STATUS DOT. This page renders LAST KNOWN CONTACT,
 * not liveness. The only thing that replicates between the user's machines is
 * the CTOX-docked mailbox-envelope collection, and the daemon's loopback
 * surface exposes publish / pending / consumed — no presence route. Event
 * replication was considered and rejected. So the server cannot tell this page
 * whether another machine is running, and the page must never imply it can:
 * the words "online" and "offline" do not appear, and `MachinesPage.test.tsx`
 * asserts that they never do. "Last known state of an offline machine" is
 * exactly what "last heard from 3d" says.
 *
 * @module components/machines/MachinesPage
 */
import type {
  WorkjetMeshDelegationStateCount,
  WorkjetMeshOverview,
  WorkjetMeshOverviewPeer,
  WorkjetMeshPeerBinding,
} from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useMeshOverview, type EnvironmentMeshOverviewStatus } from "../../state/meshOverview";
import { formatElapsedDurationLabel, parseTimestampDate } from "../../timestampFormat";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { formatWorkjetFirstContact, workjetPeerTrustLabel } from "../chat/WorkjetSendToWorkerPanel";

/** Short trust badge. The long prose stays in the peer's title attribute. */
export function machineTrustBadge(binding: WorkjetMeshPeerBinding): string {
  return binding === "self-signed" ? "Self-signed keys" : "Trusted on first contact";
}

/**
 * Collapse a peer's per-state delegation buckets into a stable, renderable
 * summary. Buckets arrive in whatever order SQL grouped them; zero counts are
 * never emitted by the server, but a defensive drop keeps a hand-built fixture
 * from rendering "0 queued".
 */
export function summarizeDelegationStates(counts: ReadonlyArray<WorkjetMeshDelegationStateCount>): {
  readonly total: number;
  readonly label: string | null;
} {
  const positive = counts.filter((entry) => entry.count > 0);
  if (positive.length === 0) return { total: 0, label: null };
  const ordered = [...positive].sort((left, right) =>
    right.count === left.count ? left.state.localeCompare(right.state) : right.count - left.count,
  );
  return {
    total: ordered.reduce((sum, entry) => sum + entry.count, 0),
    label: ordered.map((entry) => `${entry.count} ${entry.state}`).join(", "),
  };
}

export interface MachineRow {
  readonly environmentId: string;
  readonly workspaceId: string;
  /** True for the machine that produced the overview; it is always listed first. */
  readonly isLocal: boolean;
  readonly trustBadge: string | null;
  readonly trustDetail: string | null;
  readonly sealedDeliveryReady: boolean | null;
  readonly firstContact: string | null;
  /**
   * "3h" / "just now", measured against the SERVER's `observedAt`, or `null`
   * when no inbound envelope from this peer is on record. NEVER a liveness
   * claim: it is the age of the last envelope that really arrived.
   */
  readonly lastInboundAge: string | null;
  /** Age of the last envelope this machine ENQUEUED to the peer. Not a delivery proof. */
  readonly lastOutboundAge: string | null;
  readonly delegationsSent: { readonly total: number; readonly label: string | null };
  readonly delegationsReceived: { readonly total: number; readonly label: string | null };
}

/**
 * Pure projection of one environment's overview into renderable rows: the
 * observing machine first, then its peers, most recently heard from first.
 *
 * Every age is computed against `overview.observedAt` — the server's clock at
 * read time — so a client with a skewed clock renders a stale age rather than a
 * negative or wildly inflated one.
 */
export function buildMachineRows(overview: WorkjetMeshOverview): ReadonlyArray<MachineRow> {
  const observedAtMs = parseTimestampDate(overview.observedAt)?.getTime() ?? Date.now();

  const localRow: MachineRow = {
    environmentId: overview.local.environmentId,
    workspaceId: overview.local.workspaceId,
    isLocal: true,
    trustBadge: null,
    trustDetail: null,
    sealedDeliveryReady: null,
    firstContact: null,
    lastInboundAge: null,
    lastOutboundAge: null,
    delegationsSent: { total: 0, label: null },
    delegationsReceived: { total: 0, label: null },
  };

  const contactMs = (peer: WorkjetMeshOverviewPeer): number => {
    const inbound = peer.lastInboundAt
      ? (parseTimestampDate(peer.lastInboundAt)?.getTime() ?? 0)
      : 0;
    const outbound = peer.lastOutboundAt
      ? (parseTimestampDate(peer.lastOutboundAt)?.getTime() ?? 0)
      : 0;
    return Math.max(inbound, outbound);
  };

  const peerRows = [...overview.peers]
    // Most recent contact first; a peer with nothing on record sinks to the
    // bottom and is broken out of by environment id so the order is stable.
    .sort((left, right) => {
      const delta = contactMs(right) - contactMs(left);
      return delta === 0 ? left.environmentId.localeCompare(right.environmentId) : delta;
    })
    .map(
      (peer): MachineRow => ({
        environmentId: peer.environmentId,
        workspaceId: peer.workspaceId,
        isLocal: false,
        trustBadge: machineTrustBadge(peer.binding),
        trustDetail: workjetPeerTrustLabel(peer.binding),
        sealedDeliveryReady: peer.sealedDeliveryReady,
        firstContact: formatWorkjetFirstContact(peer.firstSeenAt),
        lastInboundAge: peer.lastInboundAt
          ? formatElapsedDurationLabel(peer.lastInboundAt, observedAtMs)
          : null,
        lastOutboundAge: peer.lastOutboundAt
          ? formatElapsedDurationLabel(peer.lastOutboundAt, observedAtMs)
          : null,
        delegationsSent: summarizeDelegationStates(peer.delegationsSent),
        delegationsReceived: summarizeDelegationStates(peer.delegationsReceived),
      }),
    );

  return [localRow, ...peerRows];
}

function MachineCard({ row }: { readonly row: MachineRow }) {
  return (
    <li
      data-testid={row.isLocal ? "machine-row-local" : "machine-row-peer"}
      className="rounded-lg border border-border bg-card px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm text-foreground">{row.environmentId}</p>
          <p className="truncate text-xs text-muted-foreground">{row.workspaceId}</p>
        </div>
        {row.isLocal ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
            This machine
          </span>
        ) : row.trustBadge ? (
          <span
            title={row.trustDetail ?? undefined}
            className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            {row.trustBadge}
          </span>
        ) : null}
      </div>

      {row.isLocal ? (
        <p className="mt-2 text-xs text-muted-foreground">
          The machine that produced this overview. Everything below is what it has on record.
        </p>
      ) : (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Last heard from</dt>
            <dd data-testid="machine-last-inbound" className="text-foreground">
              {row.lastInboundAge === null ? "No envelope on record" : `${row.lastInboundAge} ago`}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Last queued to it</dt>
            <dd data-testid="machine-last-outbound" className="text-foreground">
              {row.lastOutboundAge === null ? "Nothing queued" : `${row.lastOutboundAge} ago`}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">First contact</dt>
            <dd className="text-foreground">{row.firstContact}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Sealed delivery</dt>
            <dd className="text-foreground">
              {row.sealedDeliveryReady === true ? "Encryption key pinned" : "No encryption key yet"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Delegations sent</dt>
            <dd data-testid="machine-delegations-sent" className="text-right text-foreground">
              {row.delegationsSent.label ?? "None"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Delegations received</dt>
            <dd data-testid="machine-delegations-received" className="text-right text-foreground">
              {row.delegationsReceived.label ?? "None"}
            </dd>
          </div>
        </dl>
      )}
    </li>
  );
}

export interface MachinesPageViewProps {
  readonly environments: ReadonlyArray<EnvironmentMeshOverviewStatus>;
  readonly isPending: boolean;
  readonly onRefresh: () => void;
}

/**
 * Props-only view, so the projection and every honesty guarantee can be tested
 * without a runtime, exactly as the other Workjet surfaces do it.
 */
export function MachinesPageView(props: MachinesPageViewProps) {
  const anyPeers = props.environments.some(
    (environment) => (environment.overview?.peers.length ?? 0) > 0,
  );

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Every machine this one has exchanged Workjet mail with, as it last knew them. These are
            recorded facts about past envelopes, not a report of what is running right now.
          </p>
          <button
            type="button"
            onClick={props.onRefresh}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-foreground"
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
            Refresh
          </button>
        </div>

        {props.environments.length === 0 ? (
          <p data-testid="machines-no-environments" className="text-sm text-muted-foreground">
            No environment is available, so there is nothing to report yet.
          </p>
        ) : null}

        {props.isPending ? (
          <p data-testid="machines-pending" className="text-sm text-muted-foreground">
            Reading the mesh overview…
          </p>
        ) : null}

        {props.environments.map((environment) => (
          <section key={environment.environmentId} className="flex flex-col gap-3">
            {props.environments.length > 1 ? (
              <h2 className="text-sm font-medium text-foreground">{environment.label}</h2>
            ) : null}

            {environment.error !== null ? (
              <p data-testid="machines-environment-error" className="text-sm text-muted-foreground">
                {environment.error}
              </p>
            ) : null}

            {environment.overview !== null ? (
              <ul className="flex flex-col gap-2">
                {buildMachineRows(environment.overview).map((row) => (
                  <MachineCard
                    key={`${row.isLocal ? "local" : "peer"}:${row.environmentId}`}
                    row={row}
                  />
                ))}
              </ul>
            ) : null}

            {environment.overview !== null && environment.overview.truncated ? (
              <p className="text-xs text-muted-foreground">
                More machines are pinned than this list shows.
              </p>
            ) : null}
          </section>
        ))}

        {!props.isPending && props.environments.length > 0 && !anyPeers ? (
          <p data-testid="machines-empty" className="text-sm text-muted-foreground">
            No other machines have exchanged mail with this one yet. Pair another machine through
            the CTOX room invite (room, room password, and signaling URLs) in Settings → Workjet,
            then send it a message from an orchestrator thread to establish first contact.
          </p>
        ) : null}
      </div>
    </ScrollArea>
  );
}

export function MachinesPage() {
  const { environments, isPending, refresh } = useMeshOverview();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header
            className={cn(
              "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Machines breadcrumb">
              <WorkspaceBreadcrumbItem current>Machines</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </header>
        )}

        {isElectron && (
          <div
            className={cn(
              "drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Machines breadcrumb">
              <WorkspaceBreadcrumbItem current>Machines</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </div>
        )}

        <MachinesPageView environments={environments} isPending={isPending} onRefresh={refresh} />
      </div>
    </SidebarInset>
  );
}
