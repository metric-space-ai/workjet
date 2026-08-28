import type {
  CtoxMobileShellPackResolveInput,
  CtoxMobileShellPackResolveResult,
  CtoxMobileShellPackTrustKey,
  EnvironmentId,
} from "@t3tools/contracts";

import {
  validateBusinessOsShellPackDistribution,
  validateBusinessOsShellPackTrustMap,
  type TrustedBusinessOsShellPackDistribution,
} from "./shell-pack-distribution";

export interface TrustedBusinessOsShellPackResolvePort {
  readonly resolve: (
    input: CtoxMobileShellPackResolveInput,
  ) => Promise<TrustedBusinessOsShellPackDistribution>;
}

export interface BusinessOsShellPackResolveCommandPort {
  readonly execute: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: CtoxMobileShellPackResolveInput;
  }) => Promise<CtoxMobileShellPackResolveResult>;
}

export function makeProductionBusinessOsShellPackResolver(input: {
  readonly environmentId: EnvironmentId | null;
  readonly trustKeys: readonly CtoxMobileShellPackTrustKey[];
  readonly command: BusinessOsShellPackResolveCommandPort;
  readonly now?: () => number;
}): TrustedBusinessOsShellPackResolvePort {
  return {
    async resolve(expected) {
      // Refuse before issuing a credentialed request until the app actually
      // ships the reviewed current+next production trust map.
      validateBusinessOsShellPackTrustMap(input.trustKeys);
      if (input.environmentId === null) {
        throw new Error("No CTOX Backend is selected for the Business OS shell.");
      }
      const descriptor = await input.command.execute({
        environmentId: input.environmentId,
        input: expected,
      });
      return validateBusinessOsShellPackDistribution({
        descriptor,
        expected,
        trustKeys: input.trustKeys,
        now: input.now?.(),
      });
    },
  };
}
