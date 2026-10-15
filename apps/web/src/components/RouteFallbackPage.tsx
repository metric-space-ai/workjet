import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "./ui/empty";

/**
 * Ruhige Ersatzseite für unbekannte Pfade und Routenfehler (D45, D46): ein
 * deutscher Titel, genau ein Knopf „Zur Übersicht“, keine Rohdaten. Der
 * Fehlertext landet nur in der Konsole (und damit im Support-Paket).
 */
export function RouteFallbackPage({
  title,
  onLeave,
}: {
  readonly title: string;
  readonly onLeave?: () => void;
}) {
  const router = useRouter();
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground"
      data-slot="route-fallback"
    >
      <Empty>
        <EmptyHeader>
          <EmptyTitle className="text-[22px]" role="alert">
            {title}
          </EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button
            onClick={() => {
              onLeave?.();
              void router.navigate({ to: "/" });
            }}
          >
            Zur Übersicht
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

export function RouteNotFoundPage() {
  return <RouteFallbackPage title="Seite nicht gefunden" />;
}

export function RouteErrorPage({
  error,
  reset,
}: {
  readonly error: unknown;
  readonly reset: () => void;
}) {
  useEffect(() => {
    console.error("[workjet] route error", error);
  }, [error]);
  return <RouteFallbackPage title="Etwas ist schiefgelaufen" onLeave={reset} />;
}
