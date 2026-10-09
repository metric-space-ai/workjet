// Workjet fork delta: the Workjet renderer CSP has no 'unsafe-eval'. Zod probes `new Function`
// for its JIT parser when the first object schema is built, which the CSP reports as a
// violation. Every module that builds zod schemas at load time imports this module first;
// package.json lists it under `sideEffects` so bundlers keep the import.
import { z } from "zod";

z.config({ jitless: true });
