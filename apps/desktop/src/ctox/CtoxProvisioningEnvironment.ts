import { bootstrapRemoteBearerSession } from "@workjet/client-runtime/authorization";
import * as Effect from "effect/Effect";

import type { DesktopBackendStartConfig } from "../backend/DesktopBackendManager.ts";
import { DesktopLocalServiceSession } from "../backend/DesktopLocalServiceSession.ts";

/** Packaged backends use the existing protected service session. Bootstrap is
 * only for legacy pool entries; a protected-session denial must never fall back. */
export const resolveProvisioningBackendBearerToken = Effect.fn(
  "desktop.ctox.resolveProvisioningBackendBearerToken",
)(function* (config: DesktopBackendStartConfig) {
  if (config.localSession !== undefined) {
    const session = yield* DesktopLocalServiceSession;
    return yield* session.get(config);
  }
  const session = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: config.httpBaseUrl.href,
    credential: config.bootstrap.desktopBootstrapToken,
    clientMetadata: { label: "Workjet Decision Hub", deviceType: "desktop" },
  });
  return session.access_token;
});
