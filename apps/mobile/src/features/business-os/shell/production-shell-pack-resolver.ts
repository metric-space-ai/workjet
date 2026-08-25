import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { CtoxMobileShellPackTrustKey, EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { businessOsMobileShellPackEnvironment } from "../../../state/business-os-mobile-shell-pack";
import { useAtomCommand } from "../../../state/use-atom-command";
import {
  makeProductionBusinessOsShellPackResolver,
  type TrustedBusinessOsShellPackResolvePort,
} from "./shell-pack-resolver-core";

export function useProductionBusinessOsShellPackResolver(input: {
  readonly environmentId: EnvironmentId | null;
  readonly trustKeys: readonly CtoxMobileShellPackTrustKey[];
  readonly now?: () => number;
}): TrustedBusinessOsShellPackResolvePort {
  const resolveCommand = useAtomCommand(businessOsMobileShellPackEnvironment.resolve, {
    reportFailure: false,
  });

  return useMemo(
    () =>
      makeProductionBusinessOsShellPackResolver({
        ...input,
        command: {
          async execute(target) {
            const result = await resolveCommand(target);
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return result.value;
          },
        },
      }),
    [input.environmentId, input.now, input.trustKeys, resolveCommand],
  );
}
