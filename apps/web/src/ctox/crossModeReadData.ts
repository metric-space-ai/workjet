import * as Schema from "effect/Schema";
import {
  WorkjetCrossModeGetThreadLinkRpcResult,
  WorkjetCrossModeListLinksRpcResult,
  WorkjetMailboxListHandoffsRpcResult,
  WorkjetDecisionHubListResult,
  WorkjetConnectionSummary,
  type EnvironmentId,
  type WorkjetCrossModeGetThreadLinkRpcInput,
  type WorkjetCrossModeListLinksRpcInput,
  type WorkjetMailboxListHandoffsRpcInput,
} from "@workjet/contracts";
import type { CtoxAppApi } from "./ctoxClient";
import { createCtoxReadAtomFamily } from "./readAtoms";
import { CtoxLocalReadError } from "./projectReadData";

type Target<T> = { readonly environmentId: EnvironmentId; readonly input: T };
function scopedRows(
  api: CtoxAppApi,
  collection: string,
  environmentId: EnvironmentId,
  limit?: number,
) {
  return api
    .query(collection, {
      selector: { environment_id: environmentId, is_deleted: { $ne: true } },
      ...(limit === undefined ? {} : { limit }),
      sort: [{ id: "asc" }],
    })
    .get();
}
/** Correlation guard only; Core retains authorization and secret custody. */
export function verifyCtoxConnectionTarget(
  api: CtoxAppApi,
  target: { connectionId: string; instanceId: string },
  environmentId: EnvironmentId,
) {
  const rows = api
    .query("workjet_connections", {
      selector: {
        environment_id: environmentId,
        connectionId: target.connectionId,
        instanceId: target.instanceId,
        is_deleted: { $ne: true },
      },
    })
    .get()
    .map((row) => Schema.decodeUnknownSync(WorkjetConnectionSummary)(row));
  if (rows.length !== 1 || rows[0]!.status !== "ready")
    throw new CtoxLocalReadError(
      "forbidden",
      "connection_target_unavailable",
      "workjet_connections",
    );
}
const links = createCtoxReadAtomFamily<
  Target<WorkjetCrossModeListLinksRpcInput>,
  WorkjetCrossModeListLinksRpcResult
>({
  collections: ["workjet_cross_mode_links"],
  read: (api, target) =>
    Schema.decodeUnknownSync(WorkjetCrossModeListLinksRpcResult)({
      schemaVersion: 1,
      links: scopedRows(api, "workjet_cross_mode_links", target.environmentId, target.input.limit),
    }),
});
const threadLink = createCtoxReadAtomFamily<
  Target<WorkjetCrossModeGetThreadLinkRpcInput>,
  WorkjetCrossModeGetThreadLinkRpcResult
>({
  collections: ["workjet_cross_mode_links"],
  read: (api, target) => {
    const rows = api
      .query<Record<string, unknown>>("workjet_cross_mode_links", {
        selector: {
          environment_id: target.environmentId,
          "code.threadId": target.input.threadId,
          is_deleted: { $ne: true },
        },
      })
      .get();
    if (rows.length > 1)
      throw new CtoxLocalReadError("conflict", "projection_not_unique", "workjet_cross_mode_links");
    return Schema.decodeUnknownSync(WorkjetCrossModeGetThreadLinkRpcResult)({
      schemaVersion: 1,
      ...(rows[0] ? { link: rows[0] } : {}),
    });
  },
});
const handoffs = createCtoxReadAtomFamily<
  Target<WorkjetMailboxListHandoffsRpcInput>,
  WorkjetMailboxListHandoffsRpcResult
>({
  collections: ["workjet_handoffs"],
  read: (api, target) =>
    Schema.decodeUnknownSync(WorkjetMailboxListHandoffsRpcResult)({
      schemaVersion: 1,
      handoffs: scopedRows(api, "workjet_handoffs", target.environmentId, target.input.limit),
    }),
});
const connections = createCtoxReadAtomFamily<
  Target<Record<string, never>>,
  WorkjetDecisionHubListResult
>({
  collections: ["workjet_connections"],
  read: (api, target) =>
    Schema.decodeUnknownSync(WorkjetDecisionHubListResult)({
      connections: scopedRows(api, "workjet_connections", target.environmentId),
    }),
});
export const ctoxCrossModeReads = {
  workjetCrossModeLinks: (target: Target<WorkjetCrossModeListLinksRpcInput>) =>
    links(JSON.stringify(target)),
  workjetCrossModeThreadLink: (target: Target<WorkjetCrossModeGetThreadLinkRpcInput>) =>
    threadLink(JSON.stringify(target)),
  workjetMailboxHandoffs: (target: Target<WorkjetMailboxListHandoffsRpcInput>) =>
    handoffs(JSON.stringify(target)),
  workjetDecisionHubConnections: (target: Target<Record<string, never>>) =>
    connections(JSON.stringify(target)),
};
