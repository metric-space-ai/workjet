import { CtoxWorkjetComputerProjection } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import type { CtoxMachineDocument } from "./workjetLiveData";

export function projectCtoxMachine(row: CtoxMachineDocument): CtoxWorkjetComputerProjection {
  return Schema.decodeUnknownSync(CtoxWorkjetComputerProjection)({
    id: row.id,
    displayName: row.display_name,
    hostingMode: row.hosting_mode,
    status: row.status,
    capabilities: row.capabilities,
    selfHostedColocation: row.self_hosted_colocation,
  });
}
