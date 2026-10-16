import dispatchSource from "./contract/workjet-dispatch/dispatch.js?raw";
import outcomeContractSource from "./contract/workjet-dispatch/outcome-contract.js?raw";
import sha256Source from "./contract/workjet-dispatch/sha256.js?raw";

/**
 * The production `workjet.worker.dispatch` handler of the Shell v4 instance module `workjet`
 * (E54.3b), byte-identical from ctox #924 (see contract/workjet-dispatch/PIN.md). The fake core
 * loads a handler as one module without relative imports, so its three `_lib` files are joined
 * here: their `./` imports are dropped and the `export` keywords removed, nothing else changes.
 * The entry (`workjet.worker.dispatch.js`) is the one-line `handleDispatch(command, ctx)`.
 */
export function workerDispatchHandlerSource(): string {
  const strip = (source: string) =>
    source
      .split("\n")
      .filter((line) => !/^import .* from '\.\/[^']+';$/.test(line))
      .map((line) => line.replace(/^export (?=(async )?function |const )/, ""))
      .join("\n");
  return [
    strip(sha256Source),
    strip(outcomeContractSource),
    strip(dispatchSource),
    "export default async function handle(command, ctx) {\n  return handleDispatch(command, ctx);\n}\n",
  ].join("\n");
}
