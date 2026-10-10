// SPDX-License-Identifier: AGPL-3.0-only
// Generated from CTOX b34e28a5e, workjet-supervisor-route-display-v1.json.
import * as Schema from "effect/Schema";

export const RouteCapabilitiesSchema = Schema.Literals([
  "ctox.workjet.supervisor.route-capabilities.v1",
]);
export type RouteCapabilitiesSchema = typeof RouteCapabilitiesSchema.Type;

export const RouteReadCommand = Schema.Literals(["ctox.workjet.project.supervisor.route.read.v1"]);
export type RouteReadCommand = typeof RouteReadCommand.Type;

export const RouteDisplaySchema = Schema.Literals(["ctox.workjet.supervisor.route-display.v1"]);
export type RouteDisplaySchema = typeof RouteDisplaySchema.Type;

export const SupervisorRouteCapabilities = Schema.Struct({
  schema: RouteCapabilitiesSchema,
  project_id: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 256),
  ),
  supervisor_thread_id: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 256),
  ),
  read_schema: RouteDisplaySchema,
  read_command: RouteReadCommand,
});
export type SupervisorRouteCapabilities = typeof SupervisorRouteCapabilities.Type;

export const ConfiguredSupervisorRoute = Schema.Struct({
  luma_id: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 160),
  ),
  configuration_revision: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  computer_id: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 256),
  ),
  harness: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 32),
  ),
  route_id: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 160),
  ),
  model: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 256),
  ),
  catalog_checked_at_ms: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});
export type ConfiguredSupervisorRoute = typeof ConfiguredSupervisorRoute.Type;

export const RequestedRouteSource = Schema.Struct({
  execution_key: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 256),
  ),
  request_revision: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 64 && Array.from(value).length <= 64),
  ),
  error_code: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 96),
  ),
  created_at_ms: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});
export type RequestedRouteSource = typeof RequestedRouteSource.Type;

export const ActualSupervisorProducer = Schema.Struct({
  run_id: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 256),
  ),
  turn_id: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 256),
  ),
  receipt_id: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 256),
  ),
  luma_id: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 160),
  ),
  configuration_revision: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  computer_id: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 256),
  ),
  harness: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 32),
  ),
  route_id: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 160),
  ),
  model: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 256),
  ),
  catalog_checked_at_ms: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});
export type ActualSupervisorProducer = typeof ActualSupervisorProducer.Type;

export const SupervisorRouteDisplay = Schema.Struct({
  schema: RouteDisplaySchema,
  project_id: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 128),
  ),
  supervisor_thread_id: Schema.String.check(
    Schema.makeFilter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 36),
  ),
  configured: Schema.NullOr(ConfiguredSupervisorRoute),
  source: Schema.NullOr(RequestedRouteSource),
  actual: Schema.NullOr(ActualSupervisorProducer),
});
export type SupervisorRouteDisplay = typeof SupervisorRouteDisplay.Type;
