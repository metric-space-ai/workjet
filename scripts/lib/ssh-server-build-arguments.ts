// @effect-diagnostics nodeBuiltinImport:off -- Explicit build-time filesystem arguments.
import * as NodePath from "node:path";

export function sshServerBuildArguments(output: string, diagnosticProviderGatewayHost?: string): string[] {
  return [
    output,
    ...(diagnosticProviderGatewayHost === undefined
      ? []
      : ["--diagnostic-provider-gateway-host", diagnosticProviderGatewayHost]),
  ];
}

export function parseSshServerBuildArguments(args: readonly string[]): {
  output?: string;
  diagnosticProviderGatewayHost?: string;
} {
  const usage = "Expected [output directory] [--diagnostic-provider-gateway-host <absolute manifest>].";
  if (args.length === 0) return {};
  if (!args[0] || args[0].startsWith("--")) throw new Error(usage);
  if (args.length === 1) return { output: args[0] };
  if (args.length !== 3 || args[1] !== "--diagnostic-provider-gateway-host"
    || !args[2] || !NodePath.isAbsolute(args[2])) throw new Error(usage);
  return { output: args[0], diagnosticProviderGatewayHost: args[2] };
}
