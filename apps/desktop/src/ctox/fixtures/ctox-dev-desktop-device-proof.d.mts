export type DevicePublicJwk = { crv: "P-256"; kty: "EC"; x: string; y: string };
export function deviceKeyThumbprint(jwk: DevicePublicJwk): string;
export function deviceProofPayload(nonce: string, method: string, host: string, path: string, body: Uint8Array): string;
export function verifyDeviceProof(jwk: DevicePublicJwk, signature: string, payload: string): boolean;
