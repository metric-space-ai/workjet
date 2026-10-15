import type { AuthSessionState } from "@workjet/contracts";
import { squashAtomCommandFailure } from "@workjet/client-runtime/state/runtime";
import React, { startTransition, useEffect, useRef, useState, useCallback } from "react";

import { connectPairing } from "../../connection/onboarding";
import {
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { readHostedPairingRequest } from "../../hostedPairing";
import { Button } from "../ui/button";
import { AuthSurfaceShell, AuthSurfaceTitle } from "./AuthSurfaceShell";
import { Input } from "../ui/input";
import { useAtomCommand } from "../../state/use-atom-command";

export function PairingPendingSurface() {
  return (
    <AuthSurfaceShell>
      <AuthSurfaceTitle>Kopplung läuft …</AuthSurfaceTitle>
    </AuthSurfaceShell>
  );
}

export function PairingRouteSurface({
  initialErrorMessage,
  onAuthenticated,
}: {
  auth: AuthSessionState["auth"];
  initialErrorMessage?: string;
  onAuthenticated: () => void;
}) {
  const autoPairTokenRef = useRef<string | null>(peekPairingTokenFromUrl());
  const [credential, setCredential] = useState(() => autoPairTokenRef.current ?? "");
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const autoSubmitAttemptedRef = useRef(false);

  const submitCredential = useCallback(
    async (nextCredential: string) => {
      setIsSubmitting(true);
      setErrorMessage("");

      const submitError = await submitServerAuthCredential(nextCredential).then(
        () => null,
        (error) => errorMessageFromUnknown(error),
      );

      setIsSubmitting(false);

      if (submitError) {
        setErrorMessage(submitError);
        return;
      }

      startTransition(() => {
        onAuthenticated();
      });
    },
    [onAuthenticated],
  );

  const handleSubmit = useCallback(
    async (event?: React.SubmitEvent<HTMLFormElement>) => {
      event?.preventDefault();
      await submitCredential(credential);
    },
    [submitCredential, credential],
  );

  useEffect(() => {
    const token = autoPairTokenRef.current;
    if (!token || autoSubmitAttemptedRef.current) {
      return;
    }

    autoSubmitAttemptedRef.current = true;
    stripPairingTokenFromUrl();
    void submitCredential(token);
  }, [submitCredential]);

  return (
    <AuthSurfaceShell>
      <AuthSurfaceTitle>Instanz koppeln</AuthSurfaceTitle>
      <form className="flex flex-col gap-3" onSubmit={(event) => void handleSubmit(event)}>
        <label className="grid gap-1 text-xs text-muted-foreground" htmlFor="pairing-token">
          Kopplungs-Token
          <Input
            id="pairing-token"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            disabled={isSubmitting}
            nativeInput
            onChange={(event) => setCredential(event.currentTarget.value)}
            placeholder="Token einfügen"
            spellCheck={false}
            value={credential}
          />
        </label>
        {errorMessage ? (
          <p role="alert" className="text-xs text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <div>
          <Button disabled={isSubmitting || credential.trim() === ""} size="sm" type="submit">
            {isSubmitting ? "Wird gekoppelt …" : "Koppeln"}
          </Button>
        </div>
      </form>
    </AuthSurfaceShell>
  );
}

export function HostedPairingRouteSurface() {
  const connectPairingEnvironment = useAtomCommand(connectPairing, {
    reportFailure: false,
  });
  const hostedPairingRequestRef = useRef(readHostedPairingRequest());
  const [status, setStatus] = useState<"pairing" | "paired" | "error">(() =>
    hostedPairingRequestRef.current ? "pairing" : "error",
  );
  const [message, setMessage] = useState(() =>
    hostedPairingRequestRef.current ? "Verbindung wird aufgebaut …" : "Kopplungslink unvollständig",
  );
  const [canRetry, setCanRetry] = useState(false);
  const submitAttemptedRef = useRef(false);
  const tokenSubmittedRef = useRef(false);

  const submitHostedPairingRequest = useCallback(async () => {
    const request = hostedPairingRequestRef.current;

    if (!request) {
      setStatus("error");
      setMessage("Kopplungslink unvollständig");
      setCanRetry(false);
      return;
    }

    if (tokenSubmittedRef.current) {
      setStatus("error");
      setMessage("Token bereits verwendet, neuen Link anfordern");
      setCanRetry(false);
      return;
    }

    setStatus("pairing");
    setMessage("Verbindung wird aufgebaut …");
    setCanRetry(false);
    tokenSubmittedRef.current = true;

    const result = await connectPairingEnvironment({
      host: request.host,
      pairingCode: request.token,
    });
    if (result._tag === "Success") {
      setStatus("paired");
      setMessage(`${request.label || "Instanz"} gespeichert`);
      return;
    }

    tokenSubmittedRef.current = false;
    setStatus("error");
    setCanRetry(true);
    setMessage(errorMessageFromUnknown(squashAtomCommandFailure(result)));
  }, [connectPairingEnvironment]);

  useEffect(() => {
    if (submitAttemptedRef.current) {
      return;
    }
    submitAttemptedRef.current = true;

    stripPairingTokenFromUrl();
    void submitHostedPairingRequest();
  }, [submitHostedPairingRequest]);

  return (
    <AuthSurfaceShell>
      <AuthSurfaceTitle>
        {status === "paired"
          ? "Instanz gekoppelt"
          : status === "error"
            ? "Kopplung fehlgeschlagen"
            : "Instanz wird gekoppelt …"}
      </AuthSurfaceTitle>
      {status === "error" ? (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      ) : null}
      {/* Genau eine Aktion je Zustand; kein deaktivierter Statusknopf, kein Host-Rohwert. */}
      {status === "error" && canRetry ? (
        <div>
          <Button size="sm" onClick={() => void submitHostedPairingRequest()}>
            Erneut versuchen
          </Button>
        </div>
      ) : status === "paired" ? (
        <div>
          <Button size="sm" onClick={() => (window.location.href = "/")}>
            App öffnen
          </Button>
        </div>
      ) : null}
    </AuthSurfaceShell>
  );
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Anmeldung fehlgeschlagen";
}
