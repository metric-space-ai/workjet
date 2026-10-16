import type { Kernel } from "./kernel/index";

/** Explicit fixture Core fact, not a production Shell/version fallback. */
export async function seedKernelTestShell(kernel: Kernel) {
  await kernel.receivePage({
    epoch: "1",
    collection: "business_apps",
    scope_hash: "local",
    gen: 1,
    cursor_to: "0",
    complete: true,
    docs: [{ id: "shell", seq: "0", rev: "1", data: { id: "shell", active_ver: "test-shell-1" } }],
  });
}
