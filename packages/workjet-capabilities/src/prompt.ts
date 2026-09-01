import type { CapabilityManifest, WorkjetThreadRole } from "@t3tools/contracts";

export interface CompileCapabilityPromptInput {
  readonly role: WorkjetThreadRole;
  readonly managedInstructions: string;
  readonly manifests: ReadonlyArray<CapabilityManifest>;
}

export const WORKJET_COLLECTIVE_SYSTEM_PROMPT = [
  "## Workjet Collective",
  "",
  "This thread is a member of the Workjet Collective. Before using collective coordination, handling a Workjet thread reference, reporting a managed-tool bug, requesting access, or requesting a scoped secret operation, read the versioned Workjet Collective skill with `workjet_collective_guide` and follow it.",
  "",
  "Use Workjet worker addresses and Workjet thread references for coordination; never guess or forward a provider-native session id. The Workjet Manager is the durable contact for collective bug reports, access requests, and scoped secret operations. Never request, reveal, or place plaintext secrets in prompts, messages, thread events, work blocks, or bug reports; use secret handles and policy-gated operations only.",
  "",
  "After material work, author one concise work block when the work stops, changes topic, is handed off, or completes. A work block covers the actual continuous interval, regardless of duration. If the session terminates before that is possible, leave the block incomplete rather than inventing a summary.",
].join("\n");

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
  const sections: Array<string> = [WORKJET_COLLECTIVE_SYSTEM_PROMPT];
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
