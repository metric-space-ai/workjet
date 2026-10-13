import type {
  WorkjetSupervisorTurnCapabilitiesResponse,
  WorkjetSupervisorTurnKind,
} from "@workjet/contracts";
import { OptionSelect } from "../ui/option-select";
import type { NativeSupervisorScope } from "../../nativeSupervisorComposer";

export interface ScopedSupervisorTurnCapabilities {
  readonly scope: NativeSupervisorScope;
  readonly response: WorkjetSupervisorTurnCapabilitiesResponse | null;
  readonly error: string | null;
}

export function supervisorConversationSupported(
  scope: NativeSupervisorScope | null,
  capability: ScopedSupervisorTurnCapabilities | null,
): boolean {
  const response = capability?.response;
  return (
    scope !== null &&
    capability !== null &&
    response != null &&
    capability.scope.instanceId === scope.instanceId &&
    capability.scope.projectId === scope.projectId &&
    capability.scope.threadId === scope.threadId &&
    response.projectId === scope.projectId &&
    response.binding.projectId === scope.projectId &&
    response.binding.threadId === scope.threadId &&
    response.turnKinds.includes("conversation")
  );
}

/** A new message kind is Owner-selected; saved requests keep their original kind. */
export function SupervisorTurnKindPicker(props: {
  readonly scope: NativeSupervisorScope | null;
  readonly capability: ScopedSupervisorTurnCapabilities | null;
  readonly value: WorkjetSupervisorTurnKind;
  readonly disabled: boolean;
  readonly onChange: (kind: WorkjetSupervisorTurnKind) => void;
}) {
  const supported = supervisorConversationSupported(props.scope, props.capability);
  return (
    <OptionSelect
      aria-label="Nachrichtenart"
      className="w-auto"
      value={props.value}
      disabled={props.disabled}
      options={[
        { value: "work", label: "Aufgabe" },
        {
          value: "conversation",
          label: supported ? "Chat" : "Chat (nicht verfügbar)",
          disabled: !supported,
        },
      ]}
      onValueChange={(kind) => {
        if (kind === "work" || (kind === "conversation" && supported)) props.onChange(kind);
      }}
    />
  );
}
