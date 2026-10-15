import type { DesktopSshPasswordPromptRequest } from "@workjet/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { claimedSshPassword } from "../settings/sshPasswordOnce";

import { KeyRoundIcon, TriangleAlertIcon } from "lucide-react";

import { InlineNoticePortal, InlineNoticeRow, useEscapeToCancel } from "../InlineNoticeSlot";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

function describeSshTarget(request: DesktopSshPasswordPromptRequest): string {
  return request.username ? `${request.username}@${request.destination}` : request.destination;
}

function formatRemainingSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const EXPIRED_MESSAGE = "Abgelaufen, bitte neu verbinden";

function getPromptErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "SSH-Anmeldung fehlgeschlagen";
  return message.includes("expired") || message.includes("no longer pending")
    ? EXPIRED_MESSAGE
    : message;
}

/**
 * SSH-Passwortabfrage ohne Modal: eine sichere Eingabezeile direkt unter dem
 * Kopf („SSH-Passwort · nutzer@host [••••] [Verbinden] [Abbrechen]“). Sie
 * erscheint dort, wo die Verbindung angestoßen wurde, typischerweise in
 * Einstellungen › Rechner. Der Bridge-Vertrag bleibt unverändert:
 * `onSshPasswordPrompt` liefert Anfragen, `resolveSshPasswordPrompt`
 * beantwortet sie (Passwort oder `null` für Abbruch). Das Passwort wird nie
 * protokolliert und nur an den lokalen SSH-Prozess weitergereicht.
 */
export function SshPasswordPromptNotice() {
  const [queue, setQueue] = useState<readonly DesktopSshPasswordPromptRequest[]>([]);
  const currentRequest = queue[0] ?? null;

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onSshPasswordPrompt) {
      return;
    }

    return bridge.onSshPasswordPrompt((request) => {
      // „Rechner hinzufügen“ mit Passwort: die Anfrage gehört dem laufenden
      // Beitritt und wird ohne Eingabezeile beantwortet (null = abbrechen).
      const claimed = claimedSshPassword(request);
      if (claimed !== undefined) {
        void bridge.resolveSshPasswordPrompt(request.requestId, claimed);
        return;
      }
      setQueue((currentQueue) => [...currentQueue, request]);
    });
  }, []);

  if (!currentRequest) {
    return null;
  }

  return (
    <ActiveSshPasswordPrompt
      key={currentRequest.requestId}
      request={currentRequest}
      onRemove={(requestId) => {
        setQueue((currentQueue) =>
          currentQueue[0]?.requestId === requestId ? currentQueue.slice(1) : currentQueue,
        );
      }}
    />
  );
}

export function ActiveSshPasswordPrompt({
  request,
  onRemove,
}: {
  readonly request: DesktopSshPasswordPromptRequest;
  readonly onRemove: (requestId: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [responseError, setResponseError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isRespondingRef = useRef(false);
  const formId = useId();

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const expiresAtMs = Date.parse(request.expiresAt);
  const remainingMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - now) : null;
  const isExpired = remainingMs !== null && remainingMs <= 0;
  const remainingSeconds = remainingMs === null ? null : Math.ceil(remainingMs / 1_000);
  const remainingLabel =
    remainingSeconds === null ? null : formatRemainingSeconds(remainingSeconds);
  const visibleResponseError = isExpired ? EXPIRED_MESSAGE : responseError;

  const respond = async (nextPassword: string | null) => {
    if (isRespondingRef.current) {
      return;
    }

    const requestId = request.requestId;
    if (nextPassword !== null && isExpired) {
      setResponseError(EXPIRED_MESSAGE);
      return;
    }

    isRespondingRef.current = true;
    setIsResponding(true);
    setResponseError(null);
    try {
      await window.desktopBridge?.resolveSshPasswordPrompt(requestId, nextPassword);
      onRemove(requestId);
    } catch (error) {
      if (nextPassword === null) {
        onRemove(requestId);
      } else {
        setResponseError(getPromptErrorMessage(error));
      }
    } finally {
      isRespondingRef.current = false;
      setIsResponding(false);
    }
  };

  const dismissExpiredPrompt = () => {
    onRemove(request.requestId);
  };

  const cancelPrompt = () => {
    if (isExpired) {
      dismissExpiredPrompt();
      return;
    }
    void respond(null);
  };

  useEscapeToCancel(cancelPrompt, !isResponding);

  const target = describeSshTarget(request);
  const hasError = visibleResponseError !== null;

  return (
    <InlineNoticePortal>
      <InlineNoticeRow
        data-ssh-password-prompt=""
        actions={
          <>
            <Button
              data-ssh-password-submit=""
              disabled={isResponding || isExpired}
              form={formId}
              size="sm"
              type="submit"
            >
              Verbinden
            </Button>
            <Button
              data-ssh-password-cancel=""
              disabled={isResponding}
              size="sm"
              type="button"
              variant="outline"
              onClick={cancelPrompt}
            >
              {isExpired ? "Schließen" : "Abbrechen"}
            </Button>
          </>
        }
        bodyClassName="min-w-[min(100%,18rem)]"
        className="flex-wrap"
        icon={hasError ? TriangleAlertIcon : KeyRoundIcon}
        label={`SSH-Passwort für ${target}`}
        tone={hasError ? "destructive" : "neutral"}
      >
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            void respond(password);
          }}
        >
          <span className="min-w-0 break-words">
            <span className="font-medium">SSH-Passwort</span>
            <span className="text-muted-foreground"> · {target}</span>
          </span>
          <Input
            ref={inputRef}
            aria-label="SSH-Passwort"
            autoComplete="current-password"
            className="w-auto min-w-24 flex-1 sm:max-w-56"
            disabled={isResponding || isExpired}
            name="ssh-password"
            size="sm"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {hasError ? (
            <span className="min-w-0 break-words text-xs text-destructive" role="alert">
              {visibleResponseError}
            </span>
          ) : remainingLabel ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {remainingLabel}
            </span>
          ) : null}
        </form>
      </InlineNoticeRow>
    </InlineNoticePortal>
  );
}
