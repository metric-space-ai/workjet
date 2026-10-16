/**
 * Scheibe C (E49.6): instances whose launch context reports V4, as the renderer's host
 * bootstrap observed them. A V4 instance is reached only over its V4 client (WebRTC + launch
 * context); every SSH instance path (fleet administration, SSH launch, SSH invite, SSH identity)
 * stays closed for it. Unknown instances keep today's V3 behaviour.
 */
const v4Instances = new Set<string>();

export function setCtoxInstanceGeneration(
  instanceId: string,
  generation: "v4" | "v3" | null,
): void {
  if (generation === "v4") v4Instances.add(instanceId);
  else v4Instances.delete(instanceId);
}

export function isCtoxV4Instance(instanceId: string): boolean {
  return v4Instances.has(instanceId);
}

/** Tests and account switches. */
export function clearCtoxV4Instances(): void {
  v4Instances.clear();
}
