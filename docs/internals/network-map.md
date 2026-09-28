# Workjet network map

Status: implementation in progress; not a release acceptance record.

## Product contract

The home surface is a network map, outside any selected instance. Selecting an
instance in the shared selector opens that instance's Dev and Ops views. Selecting
“Netzwerkübersicht” returns to the map. A remembered project never selects an
instance implicitly.

Each network has one central computer hosting a CTOX instance with the master
role. That master owns shared sync, projects and tasks, and serves Ops / Business
OS. Other computers are satellites assigned to that network. A central computer
may also execute harness work. Desktop and mobile applications are independent
clients; a client can access multiple separate instance networks.

Business OS is a surface provided by an instance. Importing an instance must
never be labelled “Business OS hinzufügen”. “Environment” is not another object
that a user must configure in parallel with a computer.

## Map actions

- A dashed central-computer node opens the common instance setup dialog.
- Creating a master offers this computer, SSH, Tailscale and managed ctox.dev.
- Connecting an existing master offers QR, invitation link, or signaling server,
  room and connection password. The last option carries an existing invitation's
  authentication proofs; it does not mint permissions from a plain password.
- Adding a satellite opens the shared computer form inside the map, with the
  clicked instance as an explicit target. This must not change the active
  instance or navigate to Settings. Native confirmation is required before the
  map shows an assignment edge.
- Master and satellite details show the reported harness states. Installed,
  available and actively executing are distinct states.
- Registered clients and currently connected clients are distinct. Live presence
  must identify the authenticated user and Desktop/Mobile client for each
  instance, and expire after disconnect or missing heartbeats.

## Diagram composition

The network home uses the full workspace without a project sidebar. A compact
header contains the instance selector and Settings. Each instance is drawn as a
connected topology: client access above the central CTOX host, confirmed computer
assignments below it, and a dashed add-computer node. Missing resources are setup
affordances, not invented inventory.

Nodes are native keyboard-accessible buttons. Clicking a node opens its context
inspector; it never changes the selected instance. Only the explicit instance
selection action changes scope. The inspector closes independently. Zoom controls
and fit-to-width keep the graph navigable without horizontal document overflow;
an enlarged graph scrolls inside its own viewport. Reduced motion is respected.
The map has no continuous animation or graph-layout simulation.

The earlier nested text-card layout is rejected. This replacement is still a
visual draft pending actual rendered review and integrated desktop acceptance.

## Evidence boundary

The current computer projection supplies assignment, declared capabilities and
self-hosted colocation. Workjet harness inspection supplies availability. Device
bindings supply device identifiers and pairing times. These contracts do not yet
supply live user/client presence or active execution across all instance computers.
The map must say the status is not yet reported; a stored device binding must
never become a green online dot. An empty app cache is not evidence of zero apps.
Do not connect nodes by a matching display name or infer a host from an opaque ID.

Independent membership stores are used per visible network. They must not replace
or select the global active-instance inventory during read-only map inspection.
Queries use the existing native CTOX bridge and WebRTC data path, without an HTTP
business-data fallback.

## Acceptance still required

1. Fresh profile: all create/connect entry points visible on the main screen;
   no project picker, creation, search or session shortcut before selection.
2. Empty, one-network and multi-network maps; no cross-network assignment leak.
3. Click a placeholder; configure, cancel, retry and return to the same map.
4. Real local and SSH/Tailscale setup, native confirmed assignment and persistence
   after a full restart. A connected Workjet server alone is not an assigned PC.
5. Real QR/manual invitation acceptance, expiry, scanner permission denial and
   camera cleanup on back/close.
6. Select an instance, use Dev/Ops, return to the map and preserve the other
   networks. No stale project, model or computer from another instance.
7. Authenticated live client/user presence and active harness tasks, including
   disconnect, stale heartbeat and reconnect, require additional native contracts.
8. Desktop and mobile, narrow and wide layouts, keyboard navigation, app restart,
   real installed-bundle interaction and independent UI review.
