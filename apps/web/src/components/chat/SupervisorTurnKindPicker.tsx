import type {
  WorkjetSupervisorTurnCapabilitiesResponse,
  WorkjetSupervisorTurnKind,
} from "@workjet/contracts";
import { useUiText } from "../../hooks/useUiText";
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

/**
 * A new message kind is Owner-selected; saved requests keep their original kind.
 * Inline in the composer bar as two segments, never behind the gear (#590, #591).
 * Without scoped Chat support there is nothing to choose, so nothing renders.
 */
export function SupervisorTurnKindPicker(props: {
  readonly scope: NativeSupervisorScope | null;
  readonly capability: ScopedSupervisorTurnCapabilities | null;
  readonly value: WorkjetSupervisorTurnKind;
  readonly disabled: boolean;
  readonly onChange: (kind: WorkjetSupervisorTurnKind) => void;
}) {
  const t = useUiText();
  const supported = supervisorConversationSupported(props.scope, props.capability);
  if (!supported) return null;
  const options: ReadonlyArray<{ kind: WorkjetSupervisorTurnKind; label: string }> = [
    { kind: "work", label: t("Aufgabe", "Task") },
    { kind: "conversation", label: t("Chat", "Chat") },
  ];
  return (
    <div
      role="radiogroup"
      aria-label={t("Modus", "Mode")}
      aria-disabled={props.disabled || undefined}
      className="inline-flex shrink-0 gap-0.5 rounded-md border border-border p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.kind}
          type="button"
          role="radio"
          aria-checked={props.value === option.kind}
          disabled={props.disabled}
          onClick={() => {
            props.onChange(option.kind);
          }}
          className={
            props.value === option.kind
              ? "rounded px-2 py-0.5 text-xs bg-secondary text-foreground"
              : "rounded px-2 py-0.5 text-xs text-muted-foreground"
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
