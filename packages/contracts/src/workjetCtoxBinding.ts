import { normalizeWorkjetThreadConfig, type WorkjetThreadConfig } from "./workjet.ts";

/** Disabling tools revokes access, but does not erase a thread's instance identity. */
export function retainWorkjetCtoxBinding(
  previous: WorkjetThreadConfig,
  next: WorkjetThreadConfig,
): { readonly config: WorkjetThreadConfig; readonly error: string | null } {
  const before = normalizeWorkjetThreadConfig(previous);
  const after = normalizeWorkjetThreadConfig(next);
  const original = before.capabilityBindings.find(
    (binding) => binding.capabilityId === "ctox-business-os",
  );
  const requested = after.capabilityBindings.filter(
    (binding) => binding.capabilityId === "ctox-business-os",
  );
  const binding = requested[0];
  if (requested.length > 1 || (binding && !binding.target.instanceId)) {
    return { config: next, error: "CTOX Business OS requires one explicit instance binding." };
  }
  if (
    original &&
    binding &&
    (original.target.connectionId !== binding.target.connectionId ||
      original.target.instanceId !== binding.target.instanceId)
  ) {
    return {
      config: next,
      error:
        "This thread keeps its original CTOX instance. Start a new thread to use another connection.",
    };
  }
  const instanceId = original?.target.instanceId ?? binding?.target.instanceId;
  if (
    instanceId &&
    ((before.ctoxSession && before.ctoxSession.instanceId !== instanceId) ||
      (after.ctoxSession && after.ctoxSession.instanceId !== instanceId))
  ) {
    return {
      config: next,
      error: "The CTOX tool binding must match the thread's registered instance.",
    };
  }
  return {
    config:
      original && !binding
        ? { ...after, capabilityBindings: [...after.capabilityBindings, original] }
        : next,
    error: null,
  };
}
