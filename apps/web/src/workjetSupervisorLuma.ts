import type {
  CommandId,
  CtoxWorkjetProjectMetadataProjection,
  CtoxWorkjetProjectProjection,
} from "@workjet/contracts";
import type { NativeSupervisorScope } from "./nativeSupervisorComposer";
import {
  configureWorkjetProject,
  describeWorkjetProjectControlFailure,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";

export type SupervisorLumaSaveResult =
  | { readonly phase: "saved"; readonly project: CtoxWorkjetProjectMetadataProjection }
  | { readonly phase: "failed"; readonly error: string }
  | { readonly phase: "canceled" };

/** A project route changes only after its correlated native configuration receipt. */
export async function saveSupervisorLuma(input: {
  readonly scope: NativeSupervisorScope;
  readonly project: CtoxWorkjetProjectProjection;
  readonly lumaId: string | null;
  readonly commandId: CommandId;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly port?: WorkjetProjectControlPort;
}): Promise<SupervisorLumaSaveResult> {
  if (input.signal.aborted || !input.isCurrent()) return { phase: "canceled" };
  if (input.project.id !== input.scope.projectId)
    return { phase: "failed", error: "The project selection changed. Reopen its Supervisor." };
  try {
    const result = await configureWorkjetProject(
      input.scope.instanceId,
      {
        action: "project.configure",
        commandId: input.commandId,
        projectId: input.scope.projectId,
        title: input.project.title,
        supervisorLumaId: input.lumaId,
      },
      input.port,
    );
    if (input.signal.aborted || !input.isCurrent()) return { phase: "canceled" };
    if (result._tag === "failed")
      return {
        phase: "failed",
        error: describeWorkjetProjectControlFailure(result, input.scope.instanceId),
      };
    if (
      result.response.action !== "project.configure" ||
      result.response.commandId !== input.commandId ||
      result.response.project.id !== input.scope.projectId ||
      result.response.project.supervisorLumaId !== input.lumaId
    )
      return {
        phase: "failed",
        error:
          "The instance did not confirm this Supervisor selection. The saved route is retained.",
      };
    return { phase: "saved", project: result.response.project };
  } catch {
    return input.signal.aborted || !input.isCurrent()
      ? { phase: "canceled" }
      : { phase: "failed", error: "Could not save the Supervisor. Retry the selection." };
  }
}
