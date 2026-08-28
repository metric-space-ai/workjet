import { createBusinessOsMobileShellPackEnvironmentAtoms } from "@t3tools/client-runtime/state/business-os-mobile-invite";

import { connectionAtomRuntime } from "../connection/runtime";

export const businessOsMobileShellPackEnvironment =
  createBusinessOsMobileShellPackEnvironmentAtoms(connectionAtomRuntime);
