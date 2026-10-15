import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@workjet/contracts";
import * as NetService from "@workjet/shared/Net";
import * as SshAuth from "@workjet/ssh/auth";
import { resolveSshTarget, runSshCommand } from "@workjet/ssh/command";
import { discoverSshHosts } from "@workjet/ssh/config";
import {
  SshCommandError,
  SshHostDiscoveryError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "@workjet/ssh/errors";
import * as SshTunnel from "@workjet/ssh/tunnel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { AUTHORIZED_KEY_SCRIPT, ensureDesktopPublicKey } from "../computers/MachineKeyInstall.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

export type DesktopSshEnvironmentRuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;

export type DesktopSshEnvironmentOperationError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

export type DesktopSshEnvironmentDiscoverError = SshHostDiscoveryError;

export type DesktopSshEnvironmentError =
  | DesktopSshEnvironmentDiscoverError
  | DesktopSshEnvironmentOperationError;

export class DesktopSshEnvironment extends Context.Service<
  DesktopSshEnvironment,
  {
    readonly discoverHosts: (input?: {
      readonly homeDir?: string;
    }) => Effect.Effect<readonly DesktopDiscoveredSshHost[], DesktopSshEnvironmentDiscoverError>;
    /**
     * Trägt den Desktop-Schlüssel idempotent in ~/.ssh/authorized_keys des
     * Ziels ein. Ein Passwort fragt ssh über SSH_ASKPASS beim Renderer an.
     */
    readonly installAuthorizedKey?: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
    readonly ensureEnvironment: (
      target: DesktopSshEnvironmentTarget,
      options?: { readonly issuePairingToken?: boolean },
    ) => Effect.Effect<DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentOperationError>;
    readonly disconnectEnvironment: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
    readonly releaseEnvironment: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
  }
>()("@workjet/desktop/ssh/DesktopSshEnvironment") {}

export interface DesktopSshEnvironmentLayerOptions {
  readonly resolveCliPackageSpec?: () => string;
  readonly resolveCliRunner?: Effect.Effect<SshTunnel.RemoteWorkjetRunnerOptions>;
  readonly remoteStateNamespace?: string;
}

/**
 * Quellenliste „Rechner hinzufügen“: jeder Host-Eintrag aus ~/.ssh/config
 * kommt mit Benutzer, Adresse und Port aus `ssh -G`, damit die Liste ohne
 * Formular auskommt („Erkennen statt fragen“). Scheitert die Auflösung,
 * bleibt der Eintrag wie gefunden.
 */
function discoverDesktopSshHostsEffect(input?: { readonly homeDir?: string }) {
  // `ssh -G` liest immer die echte ~/.ssh/config; bei fremdem Home (Tests)
  // bleiben die Einträge daher unaufgelöst.
  if (input?.homeDir !== undefined) return discoverSshHosts(input);
  return discoverSshHosts({}).pipe(
    Effect.flatMap((hosts) =>
      Effect.forEach(
        hosts,
        (host) =>
          host.source !== "ssh-config"
            ? Effect.succeed(host)
            : resolveSshTarget(host.alias).pipe(
                Effect.map((target) => ({
                  ...host,
                  hostname: target.hostname,
                  username: target.username,
                  port: target.port,
                })),
                Effect.orElseSucceed(() => host),
              ),
        { concurrency: 8 },
      ),
    ),
  );
}

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is SshPasswordPromptError {
  return (
    error instanceof SshPasswordPromptError &&
    DesktopSshPasswordPrompts.isDesktopSshPasswordPromptCancellation(error.cause)
  );
}

function unexpectedPasswordPromptError(error: never): never {
  throw new Error(`Unhandled desktop SSH password prompt error: ${String(error)}`);
}

export function toSshPasswordPromptError(
  cause: DesktopSshPasswordPrompts.DesktopSshPasswordPromptRequestError,
): SshPasswordPromptError {
  let message: string;
  switch (cause._tag) {
    case "DesktopSshPromptRequestIdGenerationError":
      message = "Secure randomness is unavailable.";
      break;
    case "DesktopSshPromptWindowUnavailableError":
    case "DesktopSshPromptPresentationError":
      message = "Workjet window is not available for SSH authentication.";
      break;
    case "DesktopSshPromptTimedOutError":
      message = `SSH authentication timed out for ${cause.destination}.`;
      break;
    case "DesktopSshPromptCancelledError":
      message = `SSH authentication cancelled for ${cause.destination}.`;
      break;
    case "DesktopSshPromptWindowClosedError":
      message = "SSH authentication was cancelled because the app window closed.";
      break;
    case "DesktopSshPromptServiceStoppedError":
      message = "SSH password prompt service stopped.";
      break;
    default:
      return unexpectedPasswordPromptError(cause);
  }
  return new SshPasswordPromptError({ message, cause });
}

const makePasswordPrompt = (
  prompts: DesktopSshPasswordPrompts.DesktopSshPasswordPrompts["Service"],
): SshAuth.SshPasswordPrompt["Service"] => ({
  isAvailable: true,
  request: (request: SshAuth.SshPasswordRequest) =>
    prompts.request(request).pipe(Effect.mapError(toSshPasswordPromptError)),
});

export const make = Effect.gen(function* () {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
  const runtimeContext = yield* Effect.context<DesktopSshEnvironmentRuntimeServices>();
  const passwordPrompt = SshAuth.SshPasswordPrompt.of(makePasswordPrompt(prompts));

  return DesktopSshEnvironment.of({
    discoverHosts: (input) =>
      discoverDesktopSshHostsEffect(input).pipe(
        Effect.provide(runtimeContext),
        Effect.withSpan("desktop.ssh.discoverHosts"),
      ),
    installAuthorizedKey: (target) =>
      Effect.promise(() => ensureDesktopPublicKey()).pipe(
        Effect.flatMap((publicKey) =>
          runSshCommand(target, {
            remoteCommandArgs: [AUTHORIZED_KEY_SCRIPT],
            stdin: `${publicKey}\n`,
            interactiveAuth: true,
            batchMode: "no",
            timeoutMs: 60_000,
          }),
        ),
        Effect.asVoid,
        Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
        Effect.provide(runtimeContext),
        Effect.withSpan("desktop.ssh.installAuthorizedKey"),
      ),
    ensureEnvironment: (target, ensureOptions) =>
      manager
        .ensureEnvironment(target, ensureOptions)
        .pipe(
          Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.ensureEnvironment"),
        ),
    disconnectEnvironment: (target) =>
      manager
        .disconnectEnvironment(target)
        .pipe(
          Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.disconnectEnvironment"),
        ),
    releaseEnvironment: (target) =>
      manager
        .releaseEnvironment(target)
        .pipe(
          Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.releaseEnvironment"),
        ),
  });
});

export const layer = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Layer.effect(DesktopSshEnvironment, make).pipe(
    Layer.provide(
      SshTunnel.SshEnvironmentManager.layer({
        ...(options.resolveCliPackageSpec === undefined
          ? {}
          : { resolveCliPackageSpec: options.resolveCliPackageSpec }),
        ...(options.resolveCliRunner === undefined
          ? {}
          : { resolveCliRunner: options.resolveCliRunner }),
        ...(options.remoteStateNamespace === undefined
          ? {}
          : { remoteStateNamespace: options.remoteStateNamespace }),
      }),
    ),
  );
