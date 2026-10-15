import type { ReactNode } from "react";

/**
 * Ruhige Vollseite für Anmelde- und Kopplungsseiten (D40, D41): Standard-
 * Seitenlayout ohne Verlauf und ohne Eyebrow, Titel in 22 px, dicht.
 */
export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground"
      data-slot="auth-surface"
    >
      <section className="flex w-full max-w-md flex-col gap-4 text-[13.5px]">{children}</section>
    </div>
  );
}

export function AuthSurfaceTitle({ children }: { readonly children: ReactNode }) {
  return <h1 className="font-semibold text-[22px] leading-tight">{children}</h1>;
}
