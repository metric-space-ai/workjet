import type { WorkjetThreadCtoxCrewChat } from "@workjet/contracts";
import * as Context from "effect/Context";
import type { CtoxCrewMcpCapability } from "./CtoxCrewMcpCapability.ts";

/** Per-effect server handoff from native admission to provider session start.
 * Never accepted in renderer input, persisted runtime payloads or adapter config.
 * Recovery must obtain a fresh authorized claim and provide this service again.
 */
export class CtoxCrewSessionBootstrap extends Context.Service<
  CtoxCrewSessionBootstrap,
  {
    readonly binding: WorkjetThreadCtoxCrewChat;
    readonly capability: CtoxCrewMcpCapability;
    /** Instructions supplied by the native claim, never a precompiled worker persona. */
    readonly nativeInstructions: string;
  }
>()("workjet/mcp/CtoxCrewSessionBootstrap") {}
