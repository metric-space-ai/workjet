import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DesktopSshEnvironmentTargetSchema } from "./ipc.ts";
import { RemoteWorkerRequest } from "./remoteWorker.ts";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Port = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65535));
export const RemoteWorkerSourceProfile = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  target: DesktopSshEnvironmentTargetSchema,
});
export type RemoteWorkerSourceProfile = typeof RemoteWorkerSourceProfile.Type;
export const RemoteWorkerRouteReservation = Schema.Struct({
  bootstrapId: Digest,
  targetEnvironmentId: EnvironmentId,
  requestId: ThreadId,
  requestDigest: Digest,
  remotePort: Port,
});
export type RemoteWorkerRouteReservation = typeof RemoteWorkerRouteReservation.Type;
export const RemoteWorkerSourceRoute = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  targetEnvironmentId: EnvironmentId,
  requestId: ThreadId,
  requestDigest: Digest,
  port: Port,
  capability: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});
export type RemoteWorkerSourceRoute = typeof RemoteWorkerSourceRoute.Type;
export const RemoteWorkerRouteProof = Schema.Struct({
  reservation: RemoteWorkerRouteReservation,
  sourceEnvironmentId: EnvironmentId,
  capabilityDigest: Digest,
  loopbackOnly: Schema.Literal(true),
});
export type RemoteWorkerRouteProof = typeof RemoteWorkerRouteProof.Type;
export const RemoteWorkerSourcePrepareInput = Schema.Struct({
  workerRequest: RemoteWorkerRequest,
  profile: RemoteWorkerSourceProfile,
  reservation: RemoteWorkerRouteReservation,
});
export const RemoteWorkerTargetRouteInput = Schema.Struct({
  workerRequest: RemoteWorkerRequest,
  reservation: RemoteWorkerRouteReservation,
  route: RemoteWorkerSourceRoute,
});
