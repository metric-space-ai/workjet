import { APP_VERSION } from "../branding";

export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex flex-col items-center justify-center gap-3"
        aria-label="Workjet-Startbildschirm"
      >
        <img alt="Workjet" className="size-16 object-contain" src="/apple-touch-icon.png" />
        <div className="text-muted-foreground text-xs">Workjet {APP_VERSION}</div>
      </div>
    </div>
  );
}
