import * as Effect from "effect/Effect";

import { nativeWorkjetDeviceProof } from "../business-os/shell/native-business-os-surface";
import { CloudDpopError, type DpopProofSigner } from "./dpop";

/**
 * One device-owned P-256 key backs Relay, managed-control and CTOX WebRTC
 * proof-of-possession. The private key never leaves Keychain/AndroidKeyStore.
 */
export function loadNativeWorkjetDpopSigner(): Effect.Effect<DpopProofSigner, CloudDpopError> {
  return Effect.tryPromise({
    try: () => nativeWorkjetDeviceProof.key(),
    catch: (cause) =>
      new CloudDpopError({ message: "Native Workjet device proof is unavailable.", cause }),
  }).pipe(
    Effect.map((key) => ({
      publicJwk: key.publicJwk,
      thumbprint: key.thumbprint,
      sign: (message: string) =>
        Effect.tryPromise({
          try: async () => {
            const proof = await nativeWorkjetDeviceProof.sign(message);
            if (
              proof.thumbprint !== key.thumbprint ||
              proof.publicJwk.x !== key.publicJwk.x ||
              proof.publicJwk.y !== key.publicJwk.y
            ) {
              throw new Error("Native Workjet device proof key changed during signing.");
            }
            return proof.signature;
          },
          catch: (cause) =>
            new CloudDpopError({ message: "Native Workjet device proof signing failed.", cause }),
        }),
    })),
  );
}
