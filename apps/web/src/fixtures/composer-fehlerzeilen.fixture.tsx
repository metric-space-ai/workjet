/** Loopback-only fixture: Composer-Fehlerzeilen vorher/nachher; keine Instanz, keine Daten. */
import { createRoot } from "react-dom/client";
import { ArrowUpIcon } from "lucide-react";
import { ComposerErrorLine } from "../components/chat/ComposerErrorLine";
import { NativeSupervisorConnectionStatus } from "../components/chat/NativeSupervisorConnectionStatus";
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

/** Vorher: die alte Zeile zeigte den Rohtext der Preset-Wahl direkt über dem Eingabefeld. */
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
        line={
          <NativeSupervisorConnectionStatus
            message={RAW_401}
            workerStatus={null}
            recoveryAction={legacyAction("Neu verbinden")}
          />
        }
      />
      <Composer
        title="503 beim Wählen eines Presets"
        line={
          <NativeSupervisorConnectionStatus
            message={RAW_503}
            workerStatus={null}
            recoveryAction={legacyAction("Neu verbinden")}
          />
        }
      />
      <Composer
        title="503 nach 2 min"
        line={
          <NativeSupervisorConnectionStatus
            message={RAW_503}
            workerStatus={null}
            recoveryAction={legacyAction("Neu verbinden")}
          />
        }
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

createRoot(document.getElementById("root")!).render(
  <main className="flex min-h-screen flex-col gap-6 bg-background p-4 text-foreground">
    {view === "before" ? <Before /> : <After />}
  </main>,
);
