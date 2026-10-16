// Single test seam for the fake core. At pin eca39cf84 MemoryCoreTransport still lives in
// kernel/fake-core.mjs; with E52 (production kernel without fake-core) it moves to
// kernel/testkit.mjs, and only this line changes.
export { MemoryCoreTransport } from "./kernel/fake-core.mjs";
