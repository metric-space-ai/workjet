// `device.launch.renew` (contract E54.5 §2): a paired device obtains a fresh V4LaunchContext (new
// E50 ticket) on the same pairing path as the redemption. The Core sends
// {"type":"pairing_challenge",nonce,expires_at_ms} first; the device answers with
// pairing_request device.launch.renew [{instance_id, device_id, nonce, signature}], where
// signature = Ed25519(device key registered at redeem,
//                     UTF8("ctox-v4-device-renew\n") ‖ UTF8(instance_id) ‖ UTF8(device_id) ‖ UTF8(nonce))
// as unpadded base64url of the 64 signature bytes.
import { randomUUID } from "../lib/utils";
import { parseV4LaunchContext } from "./kernel/boot.mjs";
import type { V4LaunchContext } from "./kernel/index";
import { base64UrlEncode, V4_RENEW_METHOD, type V4PairingControlRequest } from "./v4DeviceInvite";
import type { V4InstanceDirectoryEntry } from "./v4InstanceDirectory";
import { V4PairingAbort, type V4PairingChallengeExchange } from "./v4PairingPeer";

export const V4_RENEW_REJECTIONS = [
  "device_unknown",
  "device_revoked",
  "signature_invalid",
  "challenge_expired",
  "rate_limited",
] as const;
export type V4RenewRejection = (typeof V4_RENEW_REJECTIONS)[number];
export type V4RenewFailureCode = V4RenewRejection | "unreachable" | "launch_context_invalid";

/** These end renewal for good; the device needs a new invitation (E54.5). */
export const V4_RENEW_UNPAIRED: ReadonlyArray<V4RenewFailureCode> = [
  "device_revoked",
  "device_unknown",
];

export type V4RenewOutcome =
  | {
      readonly ok: true;
      readonly payload: { readonly v4: unknown };
      readonly launchContext: Readonly<V4LaunchContext["v4"]>;
    }
  | { readonly ok: false; readonly code: V4RenewFailureCode };

const RENEW_DOMAIN = "ctox-v4-device-renew\n";
const textEncoder = new TextEncoder();

export function v4RenewSignedBytes(input: {
  readonly instanceId: string;
  readonly deviceId: string;
  readonly nonce: string;
}): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(`${RENEW_DOMAIN}${input.instanceId}${input.deviceId}${input.nonce}`);
}

export async function signV4RenewChallenge(
  privateKey: CryptoKey,
  input: { readonly instanceId: string; readonly deviceId: string; readonly nonce: string },
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const signature = new Uint8Array(
    await subtle.sign({ name: "Ed25519" }, privateKey, v4RenewSignedBytes(input)),
  );
  if (signature.length !== 64) throw new Error("ed25519_signature_invalid");
  return base64UrlEncode(signature);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isRejection = (value: unknown): value is V4RenewRejection =>
  typeof value === "string" && (V4_RENEW_REJECTIONS as ReadonlyArray<string>).includes(value);

export async function renewV4DeviceLaunch(options: {
  readonly entry: V4InstanceDirectoryEntry;
  readonly deviceKeys: {
    readonly existingKeyFor: (instanceId: string) => Promise<{ privateKey: CryptoKey } | undefined>;
  };
  readonly exchange: V4PairingChallengeExchange;
  readonly now?: () => number;
  readonly requestId?: () => string;
  readonly subtle?: SubtleCrypto;
}): Promise<V4RenewOutcome> {
  const { entry } = options;
  const now = options.now ?? Date.now;
  let key: { privateKey: CryptoKey } | undefined;
  try {
    key = await options.deviceKeys.existingKeyFor(entry.instanceId);
  } catch {
    return { ok: false, code: "unreachable" };
  }
  // Without the key registered at redeem this device cannot prove it is the paired one.
  if (key === undefined) return { ok: false, code: "device_unknown" };
  const privateKey = key.privateKey;
  const id = options.requestId?.() ?? randomUUID();
  let response: unknown;
  try {
    response = await options.exchange(entry.signaling, async (challenge) => {
      // An already expired challenge is not answered.
      if (challenge.expiresAtMs <= now()) throw new V4PairingAbort("challenge_expired");
      const signature = await signV4RenewChallenge(
        privateKey,
        { instanceId: entry.instanceId, deviceId: entry.deviceId, nonce: challenge.nonce },
        options.subtle,
      );
      return {
        type: "pairing_request",
        id,
        method: V4_RENEW_METHOD,
        params: [
          {
            instance_id: entry.instanceId,
            device_id: entry.deviceId,
            nonce: challenge.nonce,
            signature,
          },
        ],
      } satisfies V4PairingControlRequest;
    });
  } catch (error) {
    if (error instanceof V4PairingAbort && error.code === "challenge_expired")
      return { ok: false, code: "challenge_expired" };
    return { ok: false, code: "unreachable" };
  }
  if (!isRecord(response) || response.type !== "pairing_response")
    return { ok: false, code: "launch_context_invalid" };
  if (response.error !== undefined) {
    // The Core may reject before any request (e.g. rate_limited instead of a challenge).
    const code = isRecord(response.error) ? response.error.code : undefined;
    return { ok: false, code: isRejection(code) ? code : "launch_context_invalid" };
  }
  if (response.id !== id || !isRecord(response.result))
    return { ok: false, code: "launch_context_invalid" };
  let launchContext: Readonly<V4LaunchContext["v4"]>;
  try {
    launchContext = parseV4LaunchContext(response.result);
  } catch {
    return { ok: false, code: "launch_context_invalid" };
  }
  if (launchContext.instanceId !== entry.instanceId || launchContext.userId !== entry.userId)
    return { ok: false, code: "launch_context_invalid" };
  return { ok: true, payload: { v4: response.result.v4 }, launchContext };
}
