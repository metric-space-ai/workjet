import type { WorkjetComputerPresentationKind } from "@workjet/contracts";
import type { EnvironmentPresentation } from "../../state/environments";
import type { WorkjetEnvironmentTargetOption } from "./WorkjetComputerEditor";

function environmentPresentationKind(
  environment: EnvironmentPresentation,
): WorkjetComputerPresentationKind {
  switch (environment.entry.target._tag) {
    case "PrimaryConnectionTarget":
      return "local";
    case "RelayConnectionTarget":
      return "workjet-connect";
    case "SshConnectionTarget":
      return "ssh";
    case "BearerConnectionTarget":
      return "remote";
  }
}

export function workjetEnvironmentTargetOptions(
  environments: ReadonlyArray<EnvironmentPresentation>,
): WorkjetEnvironmentTargetOption[] {
  return environments
    .map((environment) => {
      const presentationKind = environmentPresentationKind(environment);
      const detail =
        presentationKind === "local"
          ? "Local environment"
          : presentationKind === "workjet-connect"
            ? "Relay connection"
            : presentationKind === "ssh"
              ? "SSH environment"
              : (environment.displayUrl ?? "Remote environment");
      return {
        environmentId: environment.environmentId,
        label: environment.label,
        presentationKind,
        detail,
      };
    })
    .sort((left, right) => {
      if (left.presentationKind === "local" && right.presentationKind !== "local") return -1;
      if (right.presentationKind === "local" && left.presentationKind !== "local") return 1;
      return left.label.localeCompare(right.label);
    });
}
