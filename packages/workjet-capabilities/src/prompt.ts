import type { CapabilityManifestV1, WorkjetThreadRole } from "@t3tools/contracts";

export interface CompileCapabilityPromptInput {
  readonly role: WorkjetThreadRole;
  readonly managedInstructions: string;
  readonly manifests: ReadonlyArray<CapabilityManifestV1>;
}

const roleSection = (role: WorkjetThreadRole): string => {
  switch (role) {
    case "standard":
      return "";
    case "orchestrator":
      return [
        "## Workjet Role: Orchestrator",
        "",
        "You are a Workjet orchestrator. Workers are ordinary T3 threads in the same server environment. Use `workjet_dispatch_worker` as the dispatch boundary. Delegate bounded tasks and use the returned worker thread ID to track the dispatched work.",
      ].join("\n");
    case "worker":
      return [
        "## Workjet Role: Worker",
        "",
        "You are a Workjet worker child thread. Complete the assigned task in this thread and report the result here. Do not dispatch more workers.",
      ].join("\n");
  }
};

export const compileCapabilityPrompt = ({
  role,
  managedInstructions,
  manifests,
}: CompileCapabilityPromptInput): string => {
  const sections: Array<string> = [];
  const compiledRoleSection = roleSection(role);
  const trimmedManagedInstructions = managedInstructions.trim();

  if (compiledRoleSection.length > 0) {
    sections.push(compiledRoleSection);
  }

  if (trimmedManagedInstructions.length > 0) {
    sections.push(`## Managed Instructions\n\n${trimmedManagedInstructions}`);
  }

  const seen = new Set<string>();
  for (const manifest of manifests) {
    if (seen.has(manifest.id)) {
      continue;
    }
    seen.add(manifest.id);

    const instructions = manifest.promptContribution?.instructions.trim();
    if (instructions === undefined || instructions.length === 0) {
      continue;
    }

    sections.push(`## Capability: ${manifest.id}@${manifest.version}\n\n${instructions}`);
  }

  return sections.join("\n\n");
};
