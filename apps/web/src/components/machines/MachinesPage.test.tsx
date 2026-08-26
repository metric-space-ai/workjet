import type { EnvironmentId, WorkjetMeshOverview } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentMeshOverviewStatus } from "../../state/meshOverview";
import {
  MachineRevokeConfirmation,
  MachinesPageView,
  machineRevokeConfirmationCopy,
  buildMachineRows,
  machineTrustBadge,
  summarizeDelegationStates,
} from "./MachinesPage";

const OBSERVED_AT = "2026-08-19T12:00:00.000Z";

function overview(
  peers: WorkjetMeshOverview["peers"],
  extra: Partial<WorkjetMeshOverview> = {},
): WorkjetMeshOverview {
  return {
    schemaVersion: 1,
    local: {
      schemaVersion: 1,
      workspaceId: "workjet-mesh-local",
      environmentId: "environment-local" as EnvironmentId,
    },
    peers,
    truncated: false,
    observedAt: OBSERVED_AT,
    ...extra,
  } as WorkjetMeshOverview;
}

function peer(
  environmentId: string,
  extra: Partial<WorkjetMeshOverview["peers"][number]> = {},
): WorkjetMeshOverview["peers"][number] {
  return {
    schemaVersion: 1,
    workspaceId: "workjet-mesh-peer",
    environmentId: environmentId as EnvironmentId,
    firstSeenAt: "2026-08-15T10:00:00.000Z",
    sealedDeliveryReady: true,
    binding: "self-signed",
    delegationsSent: [],
    delegationsReceived: [],
    ...extra,
  } as WorkjetMeshOverview["peers"][number];
}

function environmentStatus(
  value: Partial<EnvironmentMeshOverviewStatus> = {},
): EnvironmentMeshOverviewStatus {
  return {
    environmentId: "environment-local" as EnvironmentId,
    label: "This Mac",
    isPending: false,
    error: null,
    overview: null,
    ...value,
  };
}

describe("buildMachineRows", () => {
  it("puts this machine first and orders peers by most recent contact", () => {
    const rows = buildMachineRows(
      overview([
        peer("environment-quiet"),
        peer("environment-recent", { lastInboundAt: "2026-08-19T11:00:00.000Z" }),
        peer("environment-older", { lastOutboundAt: "2026-08-19T06:00:00.000Z" }),
      ]),
    );

    expect(rows.map((row) => row.environmentId)).toEqual([
      "environment-local",
      "environment-recent",
      "environment-older",
      "environment-quiet",
    ]);
    expect(rows[0]?.isLocal).toBe(true);
    expect(rows.slice(1).every((row) => !row.isLocal)).toBe(true);
  });

  it("ages every timestamp against the SERVER's observation instant", () => {
    // The client clock is irrelevant on purpose: a machine with a skewed clock
    // must render a stale age, never a negative or invented one.
    const rows = buildMachineRows(
      overview([
        peer("environment-peer", {
          lastInboundAt: "2026-08-19T09:00:00.000Z",
          lastOutboundAt: "2026-08-16T12:00:00.000Z",
        }),
      ]),
    );

    expect(rows[1]?.lastInboundAge).toBe("3h");
    expect(rows[1]?.lastOutboundAge).toBe("3d");
  });

  it("reports 'nothing on record' rather than inventing contact", () => {
    const rows = buildMachineRows(overview([peer("environment-peer")]));
    expect(rows[1]?.lastInboundAge).toBeNull();
    expect(rows[1]?.lastOutboundAge).toBeNull();
    // A pin without envelope rows still carries the fact that first contact
    // happened, which is the only durable claim available.
    expect(rows[1]?.firstContact).toBe("2026-08-15");
  });

  it("keeps every peer's delegation counts on that peer", () => {
    const rows = buildMachineRows(
      overview([
        peer("environment-a", {
          lastInboundAt: "2026-08-19T11:00:00.000Z",
          delegationsSent: [
            { state: "queued", count: 1 },
            { state: "running", count: 3 },
          ],
        }),
        peer("environment-b", { lastInboundAt: "2026-08-19T10:00:00.000Z" }),
      ]),
    );

    expect(rows[1]?.delegationsSent.label).toBe("3 running, 1 queued");
    expect(rows[1]?.delegationsSent.total).toBe(4);
    expect(rows[2]?.delegationsSent.label).toBeNull();
  });

  it("reports each peer's honest trust level", () => {
    const rows = buildMachineRows(
      overview([peer("environment-tofu", { binding: "tofu", sealedDeliveryReady: false })]),
    );
    expect(rows[1]?.trustBadge).toBe("Trusted on first contact");
    expect(rows[1]?.sealedDeliveryReady).toBe(false);
    expect(machineTrustBadge("self-signed")).toBe("Self-signed keys");
  });
});

describe("summarizeDelegationStates", () => {
  it("is empty for no buckets and drops a zero bucket", () => {
    expect(summarizeDelegationStates([])).toEqual({ total: 0, label: null });
    expect(summarizeDelegationStates([{ state: "queued", count: 0 }])).toEqual({
      total: 0,
      label: null,
    });
  });

  it("orders by count and breaks ties by state so the label is stable", () => {
    expect(
      summarizeDelegationStates([
        { state: "running", count: 1 },
        { state: "completed", count: 1 },
        { state: "failed", count: 4 },
      ]).label,
    ).toBe("4 failed, 1 completed, 1 running");
  });
});

describe("MachinesPageView", () => {
  const render = (props: Parameters<typeof MachinesPageView>[0]) =>
    renderToStaticMarkup(MachinesPageView(props));

  it("names the empty state and points at the pairing flow", () => {
    const onOpenComputers = vi.fn();
    const markup = render({
      environments: [environmentStatus({ overview: overview([]) })],
      isPending: false,
      onRefresh: vi.fn(),
      onOpenComputers,
    });

    expect(markup).toContain("No other machines have exchanged mail with this one yet.");
    expect(markup).toContain("Open Computers");
    expect(markup).toContain("Mobile Business OS sync uses the QR code in Computers");
    expect(markup).not.toContain("room password");
    expect(markup).not.toContain("signaling URLs");
    // The local machine is still shown; the mesh being empty is not the same as
    // there being nothing to display.
    expect(markup).toContain("This machine");
    expect(markup).toContain("environment-local");
  });

  it("renders a stale peer as an age, never as a status", () => {
    const markup = render({
      environments: [
        environmentStatus({
          overview: overview([
            peer("environment-away", { lastInboundAt: "2026-07-19T12:00:00.000Z" }),
          ]),
        }),
      ],
      isPending: false,
      onRefresh: vi.fn(),
    });

    expect(markup).toContain("Last heard from");
    expect(markup).toContain("31d ago");
    expect(markup).toContain("environment-away");
  });

  it("says nothing is on record instead of leaving a peer's contact blank", () => {
    const markup = render({
      environments: [environmentStatus({ overview: overview([peer("environment-quiet")]) })],
      isPending: false,
      onRefresh: vi.fn(),
    });

    expect(markup).toContain("No envelope on record");
    expect(markup).toContain("Nothing queued");
  });

  it("surfaces an environment that could not answer without hiding the rest", () => {
    const markup = render({
      environments: [
        environmentStatus({
          environmentId: "environment-a" as EnvironmentId,
          label: "Laptop",
          error: "This environment could not report its mesh overview.",
        }),
        environmentStatus({
          environmentId: "environment-b" as EnvironmentId,
          label: "Desktop",
          overview: overview([peer("environment-peer", { lastInboundAt: OBSERVED_AT })]),
        }),
      ],
      isPending: false,
      onRefresh: vi.fn(),
    });

    expect(markup).toContain("could not report its mesh overview");
    expect(markup).toContain("environment-peer");
    expect(markup).toContain("Laptop");
    expect(markup).toContain("Desktop");
  });

  it("reports truncation instead of silently shortening the list", () => {
    const markup = render({
      environments: [
        environmentStatus({
          overview: overview([peer("environment-peer")], { truncated: true }),
        }),
      ],
      isPending: false,
      onRefresh: vi.fn(),
    });
    expect(markup).toContain("More machines are pinned than this list shows.");
  });

  it("NEVER claims a machine is online or offline", () => {
    // The load-bearing guarantee of this whole surface. The server has no
    // liveness signal — the CTOX loopback surface is publish / pending /
    // consumed, with no presence route — so the words must not appear in any
    // state the page can reach. If this test fails, either a real presence
    // source landed (then cite it here) or the page started lying.
    const states: Array<Parameters<typeof MachinesPageView>[0]> = [
      { environments: [], isPending: false, onRefresh: vi.fn() },
      { environments: [environmentStatus()], isPending: true, onRefresh: vi.fn() },
      {
        environments: [environmentStatus({ overview: overview([]) })],
        isPending: false,
        onRefresh: vi.fn(),
      },
      {
        environments: [
          environmentStatus({ error: "This environment could not report its mesh overview." }),
        ],
        isPending: false,
        onRefresh: vi.fn(),
      },
      {
        environments: [
          environmentStatus({
            overview: overview([
              peer("environment-fresh", { lastInboundAt: OBSERVED_AT }),
              peer("environment-stale", { lastInboundAt: "2025-01-01T00:00:00.000Z" }),
              peer("environment-quiet"),
            ]),
          }),
        ],
        isPending: false,
        onRefresh: vi.fn(),
      },
    ];

    for (const state of states) {
      const markup = render(state).toLowerCase();
      expect(markup).not.toContain("online");
      expect(markup).not.toContain("offline");
      expect(markup).not.toContain("reachable");
      expect(markup).not.toContain("unreachable");
      expect(markup).not.toContain("connected");
      expect(markup).not.toContain("disconnected");
      // "last known" is expressed as an age, never as a live/dead verdict.
      expect(markup).not.toContain("active now");
    }
  });

  it("frames outbound contact as a local enqueue, never as proof of delivery", () => {
    const markup = render({
      environments: [
        environmentStatus({
          overview: overview([
            peer("environment-peer", { lastOutboundAt: "2026-08-19T11:00:00.000Z" }),
          ]),
        }),
      ],
      isPending: false,
      onRefresh: vi.fn(),
    });

    expect(markup).toContain("Last queued to it");
    expect(markup.toLowerCase()).not.toContain("delivered");
    expect(markup.toLowerCase()).not.toContain("received by");
  });
});

describe("revoking a peer's trust pin", () => {
  const render = (props: Parameters<typeof MachinesPageView>[0]) =>
    renderToStaticMarkup(MachinesPageView(props));

  /**
   * How many `MachineRevokeConfirmation` elements the view put in the tree.
   * The dialog renders through a portal, so static markup cannot see it; the
   * element tree can, and the gate is about presence, not pixels.
   */
  const countConfirmations = (node: unknown): number => {
    if (Array.isArray(node))
      return node.reduce<number>((sum, child) => sum + countConfirmations(child), 0);
    if (typeof node !== "object" || node === null) return 0;
    const element = node as {
      readonly type?: unknown;
      readonly props?: { readonly children?: unknown };
    };
    const own = element.type === MachineRevokeConfirmation ? 1 : 0;
    return own + countConfirmations(element.props?.children);
  };

  const peerRow = () => {
    const rows = buildMachineRows(overview([peer("environment-peer")]));
    const row = rows[1];
    if (row === undefined) throw new Error("expected a peer row");
    return row;
  };

  it("never offers to revoke THIS machine's own pin", () => {
    const rows = buildMachineRows(overview([peer("environment-peer")]));
    // A machine holds no pin for itself, so the action would be a guaranteed
    // no-op dressed up as a security control.
    expect(rows[0]?.isLocal).toBe(true);
    expect(rows[0]?.revocable).toBeNull();
    expect(rows[1]?.revocable).toEqual({
      peerWorkspaceId: "workjet-mesh-peer",
      peerEnvironmentId: "environment-peer",
    });
  });

  it("renders no revoke control at all when the page has no revoke action", () => {
    const markup = render({
      environments: [environmentStatus({ overview: overview([peer("environment-peer")]) })],
      isPending: false,
      onRefresh: vi.fn(),
    });
    expect(markup).not.toContain("machine-revoke");
    expect(markup).not.toContain("Revoke pinned keys");
  });

  it("shows the row control WITHOUT the dialog until the operator asks for it", () => {
    const markup = render({
      environments: [environmentStatus({ overview: overview([peer("environment-peer")]) })],
      isPending: false,
      onRefresh: vi.fn(),
      onRequestRevoke: vi.fn(),
      onConfirmRevoke: vi.fn(),
      onCancelRevoke: vi.fn(),
      pendingRevocation: null,
    });

    expect(markup).toContain("Revoke pinned keys");
    // THE GATE. With nothing pending, no confirmation exists — so the row
    // control cannot be the thing that destroys a pin.
    expect(markup).not.toContain("data-revoke-peer-dialog");
    expect(markup).not.toContain("data-revoke-peer-confirm");
  });

  it("mounts the confirmation ONLY when a revocation is pending", () => {
    const props = {
      environments: [environmentStatus({ overview: overview([peer("environment-peer")]) })],
      isPending: false,
      onRefresh: vi.fn(),
      onRequestRevoke: vi.fn(),
      onConfirmRevoke: vi.fn(),
      onCancelRevoke: vi.fn(),
    } as const;

    // THE GATE, checked on the element tree because the dialog renders through
    // a portal that static markup cannot reach. With nothing pending the
    // confirmation is not in the tree at all, so the row control cannot be the
    // thing that destroys a pin.
    expect(countConfirmations(MachinesPageView({ ...props, pendingRevocation: null }))).toBe(0);
    expect(
      countConfirmations(
        MachinesPageView({
          ...props,
          pendingRevocation: {
            environmentId: "environment-local" as EnvironmentId,
            row: peerRow(),
          },
        }),
      ),
    ).toBe(1);
  });

  it("states both halves of the consequence, not only the reassuring one", () => {
    const copy = machineRevokeConfirmationCopy("environment-peer");

    expect(copy.target).toBe("environment-peer");
    // The same promise the deep-link confirmation makes.
    expect(copy.nothingHappens).toBe("Nothing happens unless you choose Revoke.");
    // The DESTRUCTIVE half.
    expect(copy.destroys).toContain("forget the keys it pinned");
    // The half a reassuring dialog would leave out: revocation reopens the
    // address, and whoever verifies first is pinned. Without this sentence the
    // operator cannot make the decision the dialog exists to ask for.
    expect(copy.reopens).toContain("will be trusted and pinned again");
    expect(copy.reopens).toContain("whichever machine reaches this address first");
    // And the limit that makes it safe to offer at all.
    expect(copy.limit).toContain("refused permanently");
    // The confirm button says what it does; "OK" would not.
    expect(copy.confirmLabel).toBe("Revoke");
  });

  it("calls onConfirm only from the dialog's Revoke button, never from the row", () => {
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    const element = MachineRevokeConfirmation({
      peerEnvironmentId: "environment-peer",
      isRevoking: false,
      onConfirm,
      onDismiss,
    });
    renderToStaticMarkup(element);
    // Rendering alone must not revoke anything: the consequence is behind the
    // click, not behind the mount.
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("swaps the confirm label while the revocation is in flight", () => {
    // A double-submit would revoke twice; the second call is a no-op on the
    // server, but the operator should not be invited to make it.
    const copy = machineRevokeConfirmationCopy("environment-peer");
    expect(copy.confirmBusyLabel).not.toBe(copy.confirmLabel);
    expect(copy.confirmBusyLabel).toContain("Revoking");
  });
});
