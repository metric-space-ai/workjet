import type {
  CtoxWorkjetProjectControlRequest,
  CtoxWorkjetProjectProjection,
} from "@workjet/contracts";
import { ProjectId } from "@workjet/contracts";

import {
  createWorkjetProject,
  listWorkjetProjects,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";

export type WorkjetProjectCreationPhase = "checking" | "creating" | "visible" | "failed";

export interface WorkjetProjectCreationAttempt {
  readonly presentationInstanceId: string;
  readonly request: Extract<
    CtoxWorkjetProjectControlRequest,
    { readonly action: "project.create" }
  >;
}

export type WorkjetProjectCreationOutcome =
  | { readonly _tag: "visible"; readonly project: CtoxWorkjetProjectProjection }
  | {
      readonly _tag: "failed";
      readonly code:
        | "invalid_input"
        | "invalid_projection"
        | "not_active"
        | "launch_failed"
        | "authentication_required"
        | "unsupported"
        | "guest_failed"
        | "response_too_large";
    };

export interface WorkjetProjectCreationOptions {
  readonly port?: WorkjetProjectControlPort;
  readonly onPhase?: (phase: WorkjetProjectCreationPhase) => void;
}

export function workjetProjectCreationFailureMessage(
  code: Extract<WorkjetProjectCreationOutcome, { readonly _tag: "failed" }>["code"],
): string {
  switch (code) {
    case "authentication_required":
      return "Sign in to the selected instance to add this project.";
    case "unsupported":
      return "The selected instance does not provide project management. Update its Business OS shell in Settings, then retry.";
    case "not_active":
      return "The selected CTOX instance is no longer connected.";
    case "launch_failed":
      return "Workjet could not start the connection to the selected CTOX instance. Check its status in Settings, then retry.";
    default:
      return "CTOX did not confirm the project. You can retry without reopening this dialog.";
  }
}

/**
 * A folder selection identifies one logical project within one CTOX instance.
 * Keeping this id stable makes a retry idempotent even when the first create
 * response was lost after CTOX committed the projection.
 */
export async function workjetLogicalProjectId(
  presentationInstanceId: string,
  folderPath: string,
): Promise<ProjectId> {
  const normalizedPath = folderPath.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${presentationInstanceId}\u0000${normalizedPath}`),
    ),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return ProjectId.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

function exactProject(
  projects: readonly CtoxWorkjetProjectProjection[],
  projectId: string,
): CtoxWorkjetProjectProjection | undefined {
  return projects.find((project) => project.id === projectId);
}

function hasRequestedWorkingCopy(
  project: CtoxWorkjetProjectProjection,
  attempt: WorkjetProjectCreationAttempt,
): boolean {
  const requested = attempt.request.workingCopy;
  return (
    requested === undefined ||
    project.workingCopies.some(
      (copy) =>
        copy.status === "active" &&
        copy.computerId === requested.computerId &&
        copy.path === requested.path,
    )
  );
}

export async function runWorkjetProjectCreation(
  attempt: WorkjetProjectCreationAttempt,
  options: WorkjetProjectCreationOptions = {},
): Promise<WorkjetProjectCreationOutcome> {
  const onPhase = options.onPhase ?? (() => {});
  onPhase("checking");
  const listed = await listWorkjetProjects(attempt.presentationInstanceId, options.port).catch(
    () => ({ _tag: "failed", code: "guest_failed" }) as const,
  );
  if (listed._tag === "failed") {
    if (
      listed.code === "not_active" ||
      listed.code === "launch_failed" ||
      listed.code === "authentication_required" ||
      listed.code === "unsupported"
    ) {
      onPhase("failed");
      return { _tag: "failed", code: listed.code };
    }
    // Listing is an idempotency optimization, not a prerequisite for create.
    // The instance-bound project id is stable, so retrying project.create is
    // safe even when an older CTOX core rejects or cannot return project.list.
  } else {
    if (listed.response.action !== "project.list") {
      onPhase("failed");
      return { _tag: "failed", code: "invalid_projection" };
    }
    const existing = exactProject(listed.response.projects, attempt.request.projectId);
    if (existing !== undefined && hasRequestedWorkingCopy(existing, attempt)) {
      onPhase("visible");
      return { _tag: "visible", project: existing };
    }
  }

  onPhase("creating");
  const created = await createWorkjetProject(
    attempt.presentationInstanceId,
    attempt.request,
    options.port,
  ).catch(() => ({ _tag: "failed", code: "guest_failed" }) as const);
  if (created._tag === "failed") {
    onPhase("failed");
    return { _tag: "failed", code: created.code };
  }
  if (
    created.response.action !== "project.create" ||
    created.response.project.id !== attempt.request.projectId ||
    !hasRequestedWorkingCopy(created.response.project, attempt)
  ) {
    onPhase("failed");
    return { _tag: "failed", code: "invalid_projection" };
  }
  onPhase("visible");
  return { _tag: "visible", project: created.response.project };
}
