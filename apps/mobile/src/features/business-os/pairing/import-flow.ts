import type { BusinessOsRegistryDependencies } from "../registry/business-os-registry";
import { pairBusinessOsInstance } from "../registry/business-os-registry";
import { parseWorkjetBusinessOsPairLink, type ValidatedBusinessOsInvite } from "./invite";

export interface PreparedBusinessOsPairing {
  readonly invite: ValidatedBusinessOsInvite;
  readonly confirmation: {
    readonly displayName: string;
    readonly expiresAt: string;
    readonly signalingHosts: readonly string[];
  };
}

export interface ClipboardPort {
  readonly readText: () => Promise<string>;
  readonly clear: () => Promise<void>;
}

export function prepareBusinessOsPairing(
  raw: string,
  options: { readonly now?: number } = {},
): PreparedBusinessOsPairing {
  const invite = parseWorkjetBusinessOsPairLink(raw, options);
  return Object.freeze({
    invite,
    confirmation: Object.freeze({
      displayName: invite.displayName,
      expiresAt: invite.expiresAt,
      signalingHosts: Object.freeze(invite.signalingUrls.map((value) => new URL(value).host)),
    }),
  });
}

export async function commitBusinessOsPairing(
  prepared: PreparedBusinessOsPairing,
  dependencies: BusinessOsRegistryDependencies,
) {
  return pairBusinessOsInstance(prepared.invite, dependencies);
}

export async function importBusinessOsPairingFromClipboard(
  clipboard: ClipboardPort,
  confirm: (prepared: PreparedBusinessOsPairing) => Promise<boolean>,
  dependencies: BusinessOsRegistryDependencies,
  options: { readonly now?: number } = {},
) {
  const prepared = prepareBusinessOsPairing(await clipboard.readText(), options);
  if (!(await confirm(prepared))) return null;
  const instance = await commitBusinessOsPairing(prepared, dependencies);
  await clipboard.clear();
  return instance;
}
