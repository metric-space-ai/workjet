// Workjet-side typing for the vendored test entry (testkit.mjs is byte-identical upstream, E52).
// Only the surface the V4 gate tests use is declared; the core itself is typed in fake-core.d.mts.
export { MemoryCoreTransport } from "./fake-core.mjs";
