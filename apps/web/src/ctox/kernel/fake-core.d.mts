// Workjet-side typing for the vendored test core (fake-core.mjs is byte-identical upstream).
// Only the surface the V4 gate tests use is declared.
import { KernelTransport } from "./index";
export declare class MemoryCoreTransport extends KernelTransport {
  constructor(options?: {
    namespace?: string;
    latencyMs?: number;
    user?: { id: string; role: string; permissions?: string[] } | null;
    deviceLabel?: string;
  });
  readonly handlers: Map<
    string,
    (payload: unknown, context: { app_id: string; command_id: string }) => unknown
  >;
  readonly failures: Map<string, string>;
  online: boolean;
  push(collection: string, docs: ReadonlyArray<{ id: string; [key: string]: unknown }>): Promise<string[]>;
  commandRouteKnown(body: { type?: string; app_id?: string }): boolean;
  setUser(user: { id: string; role: string; permissions?: string[] }): void;
}
