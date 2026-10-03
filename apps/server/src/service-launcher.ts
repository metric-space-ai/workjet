import { runServiceLauncher } from "./serviceLauncher.ts";

runServiceLauncher().catch((cause: unknown) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  process.stderr.write(`[service-launcher] ${error.message}\n`);
  process.exitCode = 1;
});
