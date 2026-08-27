import type {
  WorkjetDeviceBindingListResult,
  WorkjetDeviceInviteCreateResult,
  WorkjetDeviceInviteRevokeResult,
  WorkjetManagedBackendControlResolveInput,
  WorkjetManagedBackendControlResolveResult,
  WorkjetManagedDeviceBindingListInput,
  WorkjetManagedDeviceInviteCreateInput,
  WorkjetManagedDeviceInviteRevokeInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class WorkjetManagedBackendControlClientError extends Data.TaggedError(
  "WorkjetManagedBackendControlClientError",
)<{
  readonly operation: "resolve" | "list" | "create" | "revoke";
  readonly message: string;
}> {}

/**
 * Platform adapter for the managed ctox.dev control plane.
 *
 * Desktop implements this in Electron main with its authenticated account
 * session; Mobile implements it with its own Workjet account + DPoP session.
 * The port intentionally has no Environment or Computer identifier, so callers
 * cannot route managed device operations through a Code worker by accident.
 */
export class WorkjetManagedBackendControlClient extends Context.Service<
  WorkjetManagedBackendControlClient,
  {
    readonly resolve: (
      input: WorkjetManagedBackendControlResolveInput,
    ) => Effect.Effect<
      WorkjetManagedBackendControlResolveResult,
      WorkjetManagedBackendControlClientError
    >;
    readonly listDeviceBindings: (
      input: WorkjetManagedDeviceBindingListInput,
    ) => Effect.Effect<WorkjetDeviceBindingListResult, WorkjetManagedBackendControlClientError>;
    readonly createDeviceInvite: (
      input: WorkjetManagedDeviceInviteCreateInput,
    ) => Effect.Effect<WorkjetDeviceInviteCreateResult, WorkjetManagedBackendControlClientError>;
    readonly revokeDeviceInvite: (
      input: WorkjetManagedDeviceInviteRevokeInput,
    ) => Effect.Effect<WorkjetDeviceInviteRevokeResult, WorkjetManagedBackendControlClientError>;
  }
>()(
  "@t3tools/client-runtime/state/businessOsManagedBackendControl/WorkjetManagedBackendControlClient",
) {}

export const resolveManagedBusinessOsBackendControl = (
  input: WorkjetManagedBackendControlResolveInput,
): Effect.Effect<
  WorkjetManagedBackendControlResolveResult,
  WorkjetManagedBackendControlClientError,
  WorkjetManagedBackendControlClient
> => Effect.flatMap(WorkjetManagedBackendControlClient, (client) => client.resolve(input));

export const listManagedWorkjetDeviceBindings = (
  input: WorkjetManagedDeviceBindingListInput,
): Effect.Effect<
  WorkjetDeviceBindingListResult,
  WorkjetManagedBackendControlClientError,
  WorkjetManagedBackendControlClient
> =>
  Effect.flatMap(WorkjetManagedBackendControlClient, (client) => client.listDeviceBindings(input));

export const createManagedWorkjetDeviceInvite = (
  input: WorkjetManagedDeviceInviteCreateInput,
): Effect.Effect<
  WorkjetDeviceInviteCreateResult,
  WorkjetManagedBackendControlClientError,
  WorkjetManagedBackendControlClient
> =>
  Effect.flatMap(WorkjetManagedBackendControlClient, (client) => client.createDeviceInvite(input));

export const revokeManagedWorkjetDeviceInvite = (
  input: WorkjetManagedDeviceInviteRevokeInput,
): Effect.Effect<
  WorkjetDeviceInviteRevokeResult,
  WorkjetManagedBackendControlClientError,
  WorkjetManagedBackendControlClient
> =>
  Effect.flatMap(WorkjetManagedBackendControlClient, (client) => client.revokeDeviceInvite(input));
