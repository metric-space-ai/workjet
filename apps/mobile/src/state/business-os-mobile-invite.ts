import { createBusinessOsMobileInviteEnvironmentAtoms } from "@t3tools/client-runtime/state/business-os-mobile-invite";

import { connectionAtomRuntime } from "../connection/runtime";

export const businessOsMobileInviteEnvironment =
  createBusinessOsMobileInviteEnvironmentAtoms(connectionAtomRuntime);
