export type InstanceSetupIntent =
  | "choose"
  | "create"
  | "connect"
  | "local"
  | "ssh"
  | "tailscale"
  | "managed"
  | "qr"
  | "link"
  | "manual";
export interface InstanceSetupRequest {
  readonly intent: InstanceSetupIntent;
  readonly revision: number;
}
let current: InstanceSetupRequest | null = null;
let revision = 0;
const listeners = new Set<() => void>();
export function openInstanceSetup(intent: InstanceSetupIntent = "choose") {
  current = { intent, revision: ++revision };
  for (const notify of listeners) notify();
}
export function closeInstanceSetup() {
  current = null;
  for (const notify of listeners) notify();
}
export const instanceSetupStore = {
  getSnapshot: () => current,
  subscribe: (notify: () => void) => {
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  },
};
