import type { CapabilityManifestV1 } from "@t3tools/contracts";

export interface CompileCapabilityPromptInput {
  readonly managedInstructions: string;
  readonly manifests: ReadonlyArray<CapabilityManifestV1>;
}

export const compileCapabilityPrompt = ({
  managedInstructions,
  manifests,
}: CompileCapabilityPromptInput): string => {
  const sections: Array<string> = [];
  const trimmedManagedInstructions = managedInstructions.trim();

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
