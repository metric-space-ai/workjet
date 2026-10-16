import { CtoxWorkjetProjectFeedPost } from "@workjet/contracts";
import type {
  CtoxWorkjetProjectControlRequest,
  CtoxWorkjetProjectControlResult,
  ProjectId,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import type { CtoxAppApi } from "./ctoxClient";
import { readLocalWorkjetKpis, readLocalWorkjetProjects } from "./workjetCollections";
import {
  CtoxLocalReadError,
  isLocalProjectRead,
  localReadFailure,
  readLocalProjectControl,
} from "./projectReadData";
import { readLocalProjectFile } from "./projectFileData";
import { GALLERY_ORDER_PREF, readAppPref, writeAppPref } from "./appPrefs";
import { newCommandId } from "../lib/utils";

const decodeFeedPost = Schema.decodeUnknownSync(CtoxWorkjetProjectFeedPost);

/**
 * V4 project control for an instance whose kernel client is bound (V4 instance only).
 * Reads are local App-API queries (E32), never commands. Returns `null` for actions that
 * still use the transitional desktop port (mutations until slice C).
 */
export function requestV4ProjectControl(
  api: CtoxAppApi,
  request: CtoxWorkjetProjectControlRequest,
): Promise<CtoxWorkjetProjectControlResult> | null {
  if (request.action === "project.list")
    return new Promise((resolve) => resolve(listV4WorkjetProjects(api)));
  // E56.2: user UI state through api.prefs (E51), before the local projection reads.
  if (request.action === "project.gallery.order.read") return readV4GalleryOrder(api, request);
  if (isLocalProjectRead(request)) {
    if (
      request.action === "project.presentation.content.read" ||
      request.action === "project.jour_fixe.narration.read"
    )
      return readLocalProjectFile(api, request).then(
        (response) => ({ _tag: "completed" as const, response }),
        localReadFailure,
      );
    try {
      return Promise.resolve({
        _tag: "completed",
        response: readLocalProjectControl(api, request),
      });
    } catch (error) {
      return Promise.resolve(localReadFailure(error));
    }
  }
  if (request.action === "project.kpis.read") {
    return new Promise<CtoxWorkjetProjectControlResult>((resolve) =>
      resolve(readV4WorkjetProjectKpis(api, request.projectId)),
    ).then((result) =>
      result._tag === "completed" && result.response.action === "project.kpis.read"
        ? { ...result, response: { ...result.response, commandId: request.commandId } }
        : result,
    );
  }
  if (request.action === "project.gallery.order.set") return writeV4GalleryOrder(api, request);
  if (request.action === "project.feed.read") {
    try {
      const posts = api
        .query<CtoxWorkjetProjectFeedPost>("workjet_project_feed", {
          selector: {
            project_id: request.projectId,
            is_deleted: { $ne: true },
            ...(request.before_ms === undefined
              ? {}
              : { occurred_at_ms: { $lt: request.before_ms } }),
          },
          sort: [{ occurred_at_ms: "desc" }],
          limit: request.limit ?? 30,
        })
        .get()
        .map((row) => decodeFeedPost(row));
      return Promise.resolve({
        _tag: "completed",
        response: {
          action: request.action,
          commandId: request.commandId,
          projectId: request.projectId,
          contract: "ctox.workjet.project_feed.v1",
          posts,
          next_before_ms: posts.at(-1)?.occurred_at_ms ?? null,
        },
      });
    } catch (error) {
      return Promise.resolve(localReadFailure(error));
    }
  }
  // No future metadata read may silently reintroduce the invisible guest path on V4.
  if (request.action.endsWith(".read"))
    return Promise.resolve(
      localReadFailure(
        new CtoxLocalReadError("unavailable", "projection_not_registered", request.action),
      ),
    );
  return null;
}

export function listV4WorkjetProjects(api: CtoxAppApi): CtoxWorkjetProjectControlResult {
  const projects = readLocalWorkjetProjects(api);
  return {
    _tag: "completed",
    response: { action: "project.list", projects, count: projects.length, truncated: false },
  };
}

export function readV4WorkjetProjectKpis(
  api: CtoxAppApi,
  projectId: ProjectId,
): CtoxWorkjetProjectControlResult {
  const kpis = readLocalWorkjetKpis(api, projectId) ?? {
    project_id: projectId,
    revision: 0,
    items: [],
  };
  return {
    _tag: "completed",
    response: {
      action: "project.kpis.read",
      commandId: newCommandId(),
      projectId,
      contract: "ctox.workjet.project_kpis.v1",
      kpis,
    },
  };
}

/**
 * E56.2: the gallery order is UI state of the signed-in user in the app `workjet`, kept in
 * `api.prefs` (E51) under `gallery.order`; no Workjet collection, no write to ctox collections,
 * never a command. The revision check of the V3 contract stays on the preference value.
 */
type GalleryOrderSet = Extract<
  CtoxWorkjetProjectControlRequest,
  { action: "project.gallery.order.set" }
>;
type GalleryOrderRead = Extract<
  CtoxWorkjetProjectControlRequest,
  { action: "project.gallery.order.read" }
>;
const decodeGalleryOrder = Schema.decodeUnknownSync(
  Schema.Struct({
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    projectIds: Schema.Array(Schema.String).check(Schema.isMaxLength(500)),
  }),
);

async function currentGalleryOrder(api: CtoxAppApi) {
  const value = await readAppPref(api, GALLERY_ORDER_PREF);
  if (value === null) return { revision: 0, projectIds: [] as ProjectId[] };
  try {
    const order = decodeGalleryOrder(value);
    return { revision: order.revision, projectIds: order.projectIds as ReadonlyArray<ProjectId> };
  } catch {
    throw new CtoxLocalReadError("invalid", "gallery_order_pref_invalid", GALLERY_ORDER_PREF);
  }
}

export async function readV4GalleryOrder(
  api: CtoxAppApi,
  request: GalleryOrderRead,
): Promise<CtoxWorkjetProjectControlResult> {
  try {
    const order = await currentGalleryOrder(api);
    return {
      _tag: "completed",
      response: {
        action: "project.gallery.order.read",
        commandId: request.commandId,
        contract: "ctox.workjet.project_gallery_order.v1",
        order: { revision: order.revision, projectIds: [...order.projectIds] },
      },
    };
  } catch (error) {
    return localReadFailure(error);
  }
}

/** Optimistic revision check against the stored preference, then `api.prefs.set`. */
export async function writeV4GalleryOrder(
  api: CtoxAppApi,
  request: GalleryOrderSet,
): Promise<CtoxWorkjetProjectControlResult> {
  try {
    const current = await currentGalleryOrder(api);
    if (current.revision !== request.expectedRevision)
      throw new CtoxLocalReadError(
        "conflict",
        "gallery_order_revision_mismatch",
        GALLERY_ORDER_PREF,
      );
    const order = { revision: current.revision + 1, projectIds: [...request.projectIds] };
    await writeAppPref(api, GALLERY_ORDER_PREF, order);
    return {
      _tag: "completed",
      response: {
        action: "project.gallery.order.set",
        commandId: request.commandId,
        contract: "ctox.workjet.project_gallery_order.v1",
        order,
      },
    };
  } catch (error) {
    return localReadFailure(error);
  }
}
