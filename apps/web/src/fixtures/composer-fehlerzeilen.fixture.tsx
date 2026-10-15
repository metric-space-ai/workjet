/** Loopback-only fixture: Composer-Fehlerzeilen vorher/nachher; keine Instanz, keine Daten. */
import { createRoot } from "react-dom/client";
import { ArrowUpIcon, WifiOffIcon } from "lucide-react";
import { connectionStatusTitle } from "@workjet/client-runtime/connection";
import { Button } from "../components/ui/button";
import { ComposerBannerStack } from "../components/chat/ComposerBannerStack";
import { environmentUnavailableBannerItem } from "../components/chat/environmentUnavailableBanner";
import { ComposerErrorLine } from "../components/chat/ComposerErrorLine";
import {
  COMPOSER_UNREACHABLE_NOTICE_MS,
  composerErrorLine,
} from "../components/chat/composerErrorLineLogic";
import "../index.css";

if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  throw new Error("Composer-Fehlerzeilen fixture requires a loopback development server.");
}

const RAW_401 = "Failed to connect to instance managed:welsch: HTTP 401 Unauthorized";
const RAW_503 = "Failed to connect. Reconnecting... Reason: Relay request failed (HTTP 503)";
const view = new URLSearchParams(location.search).get("view") ?? "after";

function Composer(props: { readonly title: string; readonly line: React.ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-3xl">
      <h2 className="mb-1 text-xs text-muted-foreground">{props.title}</h2>
      <div className="rounded-[22px] border bg-card p-3">
        {props.line}
        <textarea
          aria-label="Nachricht an Supervisor"
          placeholder="Supervisor fragen …"
          rows={2}
          className="w-full resize-none bg-transparent px-1 py-2 text-sm outline-none"
        />
        <div className="flex items-center justify-between">
          <span className="rounded-md border px-2 py-1 text-xs">Molecularity Supervisor</span>
          <span className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-40">
            <ArrowUpIcon className="size-4" aria-hidden="true" />
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * Vorher (vor #768): Nachbau der entfernten NativeSupervisorConnectionStatus-Zeile,
 * die den Rohtext der Preset-Wahl direkt über dem Eingabefeld zeigte.
 */
function LegacyStatusLine(props: { readonly message: string; readonly action: React.ReactNode }) {
  return (
    <div
      role="status"
      data-supervisor-connection-status="true"
      className="mb-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <span>{props.message}</span>
      {props.action}
    </div>
  );
}

function Before() {
  const legacyAction = (label: string) => (
    <button type="button" className="underline underline-offset-2">
      {label}
    </button>
  );
  return (
    <>
      <Composer
        title="401 beim Wählen eines Presets"
        line={<LegacyStatusLine message={RAW_401} action={legacyAction("Neu verbinden")} />}
      />
      <Composer
        title="503 beim Wählen eines Presets"
        line={<LegacyStatusLine message={RAW_503} action={legacyAction("Neu verbinden")} />}
      />
      <Composer
        title="503 nach 2 min"
        line={<LegacyStatusLine message={RAW_503} action={legacyAction("Neu verbinden")} />}
      />
    </>
  );
}

function After() {
  const auth = composerErrorLine(RAW_401, { fallback: "Preset nicht übernommen" });
  const early = composerErrorLine(RAW_503, {
    fallback: "Preset nicht übernommen",
    unreachableForMs: 30_000,
  });
  const late = composerErrorLine(RAW_503, {
    fallback: "Preset nicht übernommen",
    unreachableForMs: COMPOSER_UNREACHABLE_NOTICE_MS,
  });
  const line = (value: ReturnType<typeof composerErrorLine>) =>
    value ? <ComposerErrorLine line={value} onAction={() => {}} /> : null;
  return (
    <>
      <Composer title="401 beim Wählen eines Presets" line={line(auth)} />
      <Composer title="503 beim Wählen eines Presets (still, < 2 min)" line={line(early)} />
      <Composer title="503 nach 2 min" line={line(late)} />
    </>
  );
}

const RAW_RELAY_503 = "Relay request failed (HTTP 503)";

/** Vorher (vor dem Folge-PR): der Umgebungs-Banner, wie ChatView ihn zusammensetzte. */
function BannerBefore() {
  return (
    <>
      {[RAW_RELAY_503, "HTTP 401 Unauthorized"].map((raw) => (
        <section key={raw} className="mx-auto w-full max-w-3xl">
          <ComposerBannerStack
            items={[
              {
                id: raw,
                variant: "warning",
                icon: <WifiOffIcon />,
                title: `gpu3: ${connectionStatusTitle({ phase: "reconnecting", error: raw, traceId: null })}`,
                description: raw,
                actions: (
                  <>
                    <Button size="xs">Neu verbinden</Button>
                    <Button size="xs" variant="outline">
                      Rechner
                    </Button>
                  </>
                ),
              },
            ]}
          />
          <Composer title="" line={null} />
        </section>
      ))}
    </>
  );
}

function BannerAfter() {
  const cases = [
    { raw: RAW_RELAY_503, ms: 30_000, title: "503, < 2 min: still" },
    { raw: RAW_RELAY_503, ms: COMPOSER_UNREACHABLE_NOTICE_MS, title: "503 nach 2 min" },
    { raw: "HTTP 401 Unauthorized", ms: null, title: "401" },
  ];
  return (
    <>
      {cases.map((entry) => {
        const line = composerErrorLine(entry.raw, {
          fallback: "Instanz nicht erreichbar",
          unreachableForMs: entry.ms,
        });
        return (
          <section key={entry.title} className="mx-auto w-full max-w-3xl">
            <h2 className="mb-1 text-xs text-muted-foreground">{entry.title}</h2>
            {line ? (
              <ComposerBannerStack
                items={[
                  environmentUnavailableBannerItem({
                    environmentId: entry.title,
                    line,
                    reconnecting: false,
                    onReconnect: () => {},
                  }),
                ]}
              />
            ) : null}
            <Composer title="" line={null} />
          </section>
        );
      })}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <main className="flex min-h-screen flex-col gap-6 bg-background p-4 text-foreground">
    {view === "before" ? (
      <Before />
    ) : view === "banner-before" ? (
      <BannerBefore />
    ) : view === "banner-after" ? (
      <BannerAfter />
    ) : (
      <After />
    )}
  </main>,
);
