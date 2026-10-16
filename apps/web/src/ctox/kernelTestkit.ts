// Single test seam for the fake core: the kernel's explicit development/test entry (E52,
// kernel/testkit.mjs). The production entry kernel/index.mjs no longer exports it.
export { MemoryCoreTransport } from "./kernel/testkit.mjs";
